import { posix } from 'node:path';
import JSZip from 'jszip';
import { HttpError } from '#shared/lib';

const MB = 1024 * 1024;
export const MAX_ZIP_BYTES = 50 * MB;
// Bounds the bytes decompressed from one ZIP, so a ZIP bomb stops early.
export const MAX_UNCOMPRESSED_BYTES = 200 * MB;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_IMPORT_PAGES = 500;
export const MAX_PAGE_CHARS = 250_000;
// Depth of the imported tree alone. The caller adds the depth of the parent page.
export const MAX_IMPORT_DEPTH = 20;
// The same limits as the document create body in model.ts.
const MAX_TITLE_LENGTH = 255;
const MAX_ICON_LENGTH = 64;
// Frontmatter is stored in document metadata, which service.ts caps at 16 KB.
const MAX_FRONTMATTER_CHARS = 16_384;
const MAX_FRONTMATTER_NODES = 1_000;

export interface ImportPage {
  // The .md file the content comes from. For a folder page without one, the folder.
  path: string;
  title: string;
  icon: string | null;
  content: string;
  frontmatter: Record<string, unknown>;
  children: ImportPage[];
  // Resolved ZIP paths of the local files and of the .md pages the content refers to.
  assetRefs: string[];
  pageLinks: string[];
}

export interface ImportFile {
  path: string;
  filename: string;
  bytes: Uint8Array;
}

export interface ImportPlan {
  pages: ImportPage[];
  files: ImportFile[];
  skipped: string[];
}

interface TreeNode {
  key: string;
  name: string;
  source: string | null;
  children: TreeNode[];
}

const MARKDOWN = /\.md$/i;
const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Reads a ZIP of Markdown files into the pages and files to create. Every folder that
// holds a .md file becomes a page, so a ZIP of one wrapped folder imports as one root
// page with that folder's name, the same as a folder the browser packs itself.
export async function readMarkdownZip(data: Uint8Array): Promise<ImportPlan> {
  const { entries, skipped } = await openZip(data);
  const budget = { left: MAX_UNCOMPRESSED_BYTES };

  const markdown = [...entries.keys()].filter((path) => MARKDOWN.test(path)).sort();
  const roots = buildTree(markdown);
  const pageCount = countNodes(roots);
  if (pageCount > MAX_IMPORT_PAGES) {
    throw new HttpError(400, `The import has ${pageCount} pages, the limit is ${MAX_IMPORT_PAGES}`);
  }

  assertDeclaredSizes(entries, markdown, budget);
  const pagePaths = new Set(markdown);
  const readNode = async (node: TreeNode): Promise<ImportPage> => {
    const page = node.source
      ? await readPage(entries, node.source, node.name, budget, pagePaths)
      : emptyPage(node.key, node.name);
    for (const child of node.children) page.children.push(await readNode(child));
    return page;
  };
  const pages: ImportPage[] = [];
  for (const root of roots) pages.push(await readNode(root));

  const referenced = new Set(flatten(pages).flatMap((page) => page.assetRefs));
  const assetPaths = [...referenced].sort();
  assertDeclaredSizes(entries, assetPaths, budget);
  const files: ImportFile[] = [];
  for (const path of assetPaths) {
    const bytes = await readEntry(entries.get(path)!, budget);
    files.push({ path, filename: posix.basename(path), bytes });
  }
  for (const path of entries.keys()) {
    if (!MARKDOWN.test(path) && !referenced.has(path)) skipped.add(path);
  }
  return { pages, files, skipped: [...skipped].sort() };
}

// Rewrites the references listed in a page's assetRefs and pageLinks. `urls` maps a
// resolved ZIP path to its new URL. A reference to a path without a URL stays unchanged.
export function rewriteReferences(
  page: Pick<ImportPage, 'path' | 'content'>,
  urls: ReadonlyMap<string, string>,
): string {
  return mapReferences(page.content, posix.dirname(page.path), (path) => urls.get(path));
}

async function openZip(data: Uint8Array) {
  if (data.byteLength > MAX_ZIP_BYTES) {
    throw new HttpError(413, `The ZIP file exceeds the ${MAX_ZIP_BYTES / MB} MB limit`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new HttpError(400, 'The file is not a valid ZIP archive');
  }
  const all = Object.values(zip.files);
  if (all.length > MAX_ZIP_ENTRIES) {
    throw new HttpError(400, `The ZIP file has more than ${MAX_ZIP_ENTRIES} entries`);
  }
  const entries = new Map<string, JSZip.JSZipObject>();
  const skipped = new Set<string>();
  for (const entry of all) {
    // jszip removes ".." from `name`; the original name is the one to check.
    const segments = entrySegments(entry.unsafeOriginalName ?? entry.name);
    const hidden = segments.findIndex((s) => s.startsWith('.') || s === '__MACOSX');
    if (hidden >= 0) {
      const isFolder = entry.dir || hidden < segments.length - 1;
      skipped.add(segments.slice(0, hidden + 1).join('/') + (isFolder ? '/' : ''));
    } else if (!entry.dir && segments.length > 0) {
      entries.set(segments.join('/'), entry);
    }
  }
  return { entries, skipped };
}

function entrySegments(name: string): string[] {
  const segments = name.split('/').filter((s) => s !== '' && s !== '.');
  if (
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    segments.includes('..')
  ) {
    throw new HttpError(400, `The ZIP file contains an unsafe path: "${name.slice(0, 200)}"`);
  }
  return segments;
}

// Folder content comes from index.md, then README.md inside it, then a sibling
// <folder>.md, matched case-insensitively. That file then is no page of its own. Of
// names that differ only by case (README.md, readme.md) the first in sorted order is
// the content and the others stay pages.
function buildTree(markdown: string[]): TreeNode[] {
  const byLowerCase = new Map<string, string[]>();
  for (const path of markdown) {
    const key = path.toLowerCase();
    byLowerCase.set(key, [...(byLowerCase.get(key) ?? []), path]);
  }
  const folders = new Set<string>();
  for (const path of markdown) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const roots: TreeNode[] = [];
  const folderNodes = new Map<string, TreeNode>();
  const used = new Set<string>();
  const attach = (node: TreeNode) => {
    if (node.key.split('/').length > MAX_IMPORT_DEPTH) {
      throw new HttpError(400, `"${node.key}" is nested deeper than ${MAX_IMPORT_DEPTH} levels`);
    }
    const dir = posix.dirname(node.key);
    (dir === '.' ? roots : folderNodes.get(dir)!.children).push(node);
  };
  const byDepth = [...folders].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const folder of byDepth) {
    const source =
      [`${folder}/index.md`, `${folder}/readme.md`, `${folder}.md`]
        .flatMap((candidate) => byLowerCase.get(candidate.toLowerCase()) ?? [])
        .find((path) => !used.has(path)) ?? null;
    if (source) used.add(source);
    const node: TreeNode = { key: folder, name: posix.basename(folder), source, children: [] };
    folderNodes.set(folder, node);
    attach(node);
  }
  for (const path of markdown) {
    if (used.has(path)) continue;
    attach({ key: path, name: posix.basename(path), source: path, children: [] });
  }
  sortTree(roots);
  return roots;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => naturalOrder.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));
  for (const node of nodes) sortTree(node.children);
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function flatten(pages: ImportPage[]): ImportPage[] {
  return pages.flatMap((page) => [page, ...flatten(page.children)]);
}

function emptyPage(path: string, name: string): ImportPage {
  return {
    path,
    title: name.slice(0, MAX_TITLE_LENGTH),
    icon: null,
    content: '',
    frontmatter: {},
    children: [],
    assetRefs: [],
    pageLinks: [],
  };
}

async function readPage(
  entries: Map<string, JSZip.JSZipObject>,
  path: string,
  name: string,
  budget: { left: number },
  pagePaths: ReadonlySet<string>,
): Promise<ImportPage> {
  const bytes = await readEntry(entries.get(path)!, budget);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, `"${path}" is not valid UTF-8`);
  }
  const { data, body } = splitFrontmatter(text, path);
  const { title: rawTitle, icon: rawIcon, ...frontmatter } = data;
  const frontmatterTitle =
    typeof rawTitle === 'string' || typeof rawTitle === 'number' ? String(rawTitle).trim() : '';
  const title = (frontmatterTitle || name.replace(MARKDOWN, '')).slice(0, MAX_TITLE_LENGTH);
  const trimmedIcon = typeof rawIcon === 'string' ? rawIcon.trim() : '';
  const icon = trimmedIcon && trimmedIcon.length <= MAX_ICON_LENGTH ? trimmedIcon : null;
  const content = removeTitleHeading(body, title);
  if (content.length > MAX_PAGE_CHARS) {
    throw new HttpError(
      400,
      `"${path}" exceeds the ${MAX_PAGE_CHARS.toLocaleString('en-US')} character limit`,
    );
  }
  const assetRefs = new Set<string>();
  const pageLinks = new Set<string>();
  mapReferences(content, posix.dirname(path), (target) => {
    if (pagePaths.has(target)) pageLinks.add(target);
    else if (entries.has(target)) assetRefs.add(target);
    return undefined;
  });
  return {
    path,
    title,
    icon,
    content,
    frontmatter,
    children: [],
    assetRefs: [...assetRefs],
    pageLinks: [...pageLinks],
  };
}

// The declared sizes come from the ZIP directory and can lie; readEntry counts the
// real bytes. This check only refuses an honest oversized ZIP before any inflating.
function assertDeclaredSizes(
  entries: Map<string, JSZip.JSZipObject>,
  paths: string[],
  budget: { left: number },
): void {
  // jszip keeps the declared size on a private field and has no public accessor.
  const declared = paths.reduce(
    (sum, path) =>
      sum +
      ((entries.get(path) as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize ?? 0),
    0,
  );
  if (declared > budget.left) throw uncompressedTooLarge();
}

function readEntry(entry: JSZip.JSZipObject, budget: { left: number }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      budget.left -= chunk.length;
      if (budget.left < 0) {
        (stream as unknown as { destroy(): void }).destroy();
        reject(uncompressedTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', () => reject(new HttpError(400, `"${entry.name}" could not be read`)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function uncompressedTooLarge(): HttpError {
  return new HttpError(413, `The ZIP file unpacks to more than ${MAX_UNCOMPRESSED_BYTES / MB} MB`);
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

// A leading block that is no YAML mapping stays in the content: "---" also opens a
// Markdown thematic break.
function splitFrontmatter(
  text: string,
  path: string,
): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  const tooLarge = () => new HttpError(400, `The frontmatter of "${path}" is too large`);
  if ((match[1]?.length ?? 0) > MAX_FRONTMATTER_CHARS) throw tooLarge();
  let data: unknown = {};
  try {
    if (match[1] !== undefined) data = Bun.YAML.parse(match[1]);
  } catch {
    return { data: {}, body: text };
  }
  if (!isPlainObject(data)) return { data: {}, body: text };
  // YAML aliases can expand a short text into a huge or cyclic value.
  let nodes = 0;
  const walk = (value: unknown): void => {
    if (++nodes > MAX_FRONTMATTER_NODES) throw tooLarge();
    if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(data);
  return { data, body: text.slice(match[0].length) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function removeTitleHeading(body: string, title: string): string {
  const rest = body.replace(/^(?:[ \t]*\r?\n)*/, '');
  const end = rest.indexOf('\n');
  const line = (end === -1 ? rest : rest.slice(0, end)).replace(/\r$/, '');
  if (!/^ {0,3}#[ \t]/.test(line)) return body;
  const heading = line
    .trim()
    .slice(1)
    .replace(/(?:^|[ \t])#+$/, '')
    .trim();
  if (heading !== title) return body;
  return end === -1 ? '' : rest.slice(end + 1).replace(/^(?:[ \t]*\r?\n)*/, '');
}

// Code fences and code spans are matched first so that references inside them stay
// untouched. Then: a Markdown link or image destination "](dest", a reference definition
// "[id]: dest", and an HTML <img src>.
const REFERENCE =
  /((?:^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\2|(?![\s\S])))|`[^`\n]*`)|(\]\([ \t]*)(<[^>\n]*>|[^\s)]+)|(^ {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)|(<img\b[^>]{0,1000}?\ssrc[ \t]*=[ \t]*)("[^"]*"|'[^']*'|[^\s>]+)/gim;

function mapReferences(
  content: string,
  dir: string,
  replace: (path: string) => string | undefined,
): string {
  return content.replace(
    REFERENCE,
    (
      match: string,
      code: string | undefined,
      _fence: string | undefined,
      linkPrefix: string | undefined,
      linkDest: string | undefined,
      defPrefix: string | undefined,
      defDest: string | undefined,
      imgPrefix: string | undefined,
      imgSrc: string | undefined,
    ) => {
      if (code !== undefined) return match;
      const prefix = linkPrefix ?? defPrefix ?? imgPrefix ?? '';
      const raw = linkDest ?? defDest ?? imgSrc ?? '';
      const open = /^["'<]/.test(raw) ? raw[0] : '';
      const target = resolveTarget(open ? raw.slice(1, -1) : raw, dir);
      const url = target && replace(target.path);
      if (!target || url === undefined) return match;
      const close = open === '<' ? '>' : open;
      return `${prefix}${open}${url}${target.fragment}${close}`;
    },
  );
}

// External URLs, anchors and root-relative paths are no file in the ZIP. A query is
// dropped from a rewritten reference; a #fragment is kept.
function resolveTarget(dest: string, dir: string): { path: string; fragment: string } | null {
  if (!dest || /^(?:[a-z][a-z0-9+.-]*:|[#/])/i.test(dest)) return null;
  const cut = dest.search(/[?#]/);
  const rawPath = cut === -1 ? dest : dest.slice(0, cut);
  const hash = dest.indexOf('#');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const path = posix.normalize(posix.join(dir, decoded));
  if (path === '..' || path.startsWith('../')) return null;
  return { path, fragment: hash === -1 ? '' : dest.slice(hash) };
}
