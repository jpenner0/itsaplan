import JSZip from 'jszip';
import { parse as parseYaml } from 'yaml';

// Mirror `MARKDOWN_IMPORT_LIMITS`, `MARKDOWN_IMPORT_MAX_DEPTH` and the mapping rules of
// apps/api/src/modules/documents/markdown-import.ts; the preview must match what the api creates.
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_PAGES = 500;
const MAX_PAGE_CHARACTERS = 250_000;
const MAX_TITLE_LENGTH = 255;
// 1 allows top-level pages only.
const MAX_DEPTH = 10;

export interface PickedFile {
  path: string;
  file: File;
}

export interface PreviewNode {
  title: string;
  children: PreviewNode[];
}

export type ImportViolation =
  | { kind: 'zipSize' }
  | { kind: 'unpackedSize' }
  | { kind: 'entryCount' }
  | { kind: 'pageCount'; count: number }
  | { kind: 'pageLength'; path: string }
  | { kind: 'invalidUtf8'; path: string }
  | { kind: 'depth'; path: string };

export interface MarkdownImportPreview {
  tree: PreviewNode[];
  pageCount: number;
  assetCount: number;
  skipped: string[];
  violations: ImportViolation[];
}

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const segmentsOf = (path: string) =>
  path.split('/').filter((segment) => segment !== '' && segment !== '.');
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isMarkdown = (path: string) => path.toLowerCase().endsWith('.md');

// A folder picked with `webkitdirectory` carries its own name as the first segment.
export function dropCommonRoot(files: PickedFile[]): PickedFile[] {
  const roots = new Set(files.map(({ path }) => segmentsOf(path)[0]));
  if (roots.size !== 1 || files.some(({ path }) => segmentsOf(path).length < 2)) return files;
  return files.map(({ path, file }) => ({ path: segmentsOf(path).slice(1).join('/'), file }));
}

export const pickedFolderFiles = (files: File[]): PickedFile[] =>
  dropCommonRoot(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));

// Stops reading once the unpacked size passes the limit, so a ZIP bomb is not fully expanded.
export async function readMarkdownZip(zipFile: File): Promise<{
  files: PickedFile[];
  violations: ImportViolation[];
}> {
  if (zipFile.size > MAX_ZIP_BYTES) return { files: [], violations: [{ kind: 'zipSize' }] };
  const zip = await JSZip.loadAsync(zipFile);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) return { files: [], violations: [{ kind: 'entryCount' }] };
  const files: PickedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const blob = await entry.async('blob');
    total += blob.size;
    if (total > MAX_UNPACKED_BYTES) return { files: [], violations: [{ kind: 'unpackedSize' }] };
    files.push({ path: entry.name, file: new File([blob], basename(entry.name)) });
  }
  return { files, violations: [] };
}

// The first hidden segment, with a trailing slash when it is a folder.
function hiddenPrefix(path: string): string | null {
  const segments = path.split('/');
  const index = segments.findIndex((s) => s.startsWith('.') || s === '__MACOSX');
  if (index === -1) return null;
  const prefix = segments.slice(0, index + 1).join('/');
  return index === segments.length - 1 ? prefix : `${prefix}/`;
}

const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const ATX_H1 = /^# +(.*?)(?: +#+)? *(?:\n|$)/;

// A block that is not a YAML mapping stays in the content, so a leading `---` rule survives.
function parseFrontmatter(source: string): Record<string, unknown> | null {
  if (source.trim() === '') return {};
  try {
    const value: unknown = parseYaml(source, { schema: 'core' });
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The block is not frontmatter.
  }
  return null;
}

function parsePage(text: string, fallbackTitle: string): { title: string; content: string } {
  let content = text.replace(/\r\n?/g, '\n');
  let frontmatter: Record<string, unknown> = {};
  const block = FRONTMATTER.exec(content);
  const data = block ? parseFrontmatter(block[1] ?? '') : null;
  if (block && data) {
    frontmatter = data;
    content = content.slice(block[0].length);
  }
  const rawTitle = frontmatter.title;
  const fromFrontmatter =
    typeof rawTitle === 'string' || typeof rawTitle === 'number' ? String(rawTitle).trim() : '';
  const title = (fromFrontmatter || fallbackTitle).slice(0, MAX_TITLE_LENGTH);
  content = content.replace(/^\n+/, '');
  const heading = ATX_H1.exec(content);
  if (heading && heading[1].trim() === title) {
    content = content.slice(heading[0].length).replace(/^\n+/, '');
  }
  return { title, content };
}

const MARKDOWN_LINK = /\]\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)/g;
const HTML_IMG = /<img\b[^<>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;

// Blanks fenced code and inline code spans so the reference scan skips them.
function maskCode(content: string): string {
  const text = content.replace(FENCED_CODE, (block) => block.replace(/[^\n]/g, ' '));
  // A code span runs to the next backtick run of the same length. Indexing the next run of each
  // length keeps this linear on pages with many unmatched backticks.
  const runs = [...text.matchAll(/`+/g)];
  const nextSameLength: number[] = [];
  const latest = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    nextSameLength[i] = latest.get(runs[i][0].length) ?? -1;
    latest.set(runs[i][0].length, i);
  }
  let masked = '';
  let copied = 0;
  for (let i = 0; i < runs.length;) {
    const close = nextSameLength[i];
    if (close === -1) {
      i += 1;
      continue;
    }
    const start = runs[i].index;
    const end = runs[close].index + runs[close][0].length;
    masked += text.slice(copied, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
    copied = end;
    i = close + 1;
  }
  return masked + text.slice(copied);
}

function resolveReference(raw: string, sourcePath: string): string | null {
  const url = raw.startsWith('<') ? raw.slice(1, -1).trim() : raw;
  if (url === '' || /^[a-z][a-z\d+.-]*:/i.test(url) || /^[/#?]/.test(url)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  const segments = sourcePath.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join('/') : null;
}

function referencedPaths(content: string, sourcePath: string): string[] {
  const text = maskCode(content);
  const raws = [
    ...[...text.matchAll(MARKDOWN_LINK)].map((m) => m[1]),
    ...[...text.matchAll(HTML_IMG)].map((m) => m[1] ?? m[2] ?? m[3]),
  ];
  return raws.flatMap((raw) => resolveReference(raw, sourcePath) ?? []);
}

function folderTree(paths: string[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const path of paths) {
    let folder = root;
    for (const segment of path.split('/').slice(0, -1)) {
      let child = folder.folders.get(segment);
      if (!child) {
        const childPath = folder.path ? `${folder.path}/${segment}` : segment;
        child = { name: segment, path: childPath, folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(path);
  }
  return root;
}

// `index.md`, then `README.md` inside the folder, then a sibling `<folder>.md`.
function folderContentFile(folder: Folder, parent: Folder): string | null {
  for (const wanted of ['index.md', 'readme.md']) {
    const match = folder.files.filter((file) => basename(file).toLowerCase() === wanted).sort()[0];
    if (match) return match;
  }
  return parent.files.find((file) => basename(file).slice(0, -3) === folder.name) ?? null;
}

interface Analysis extends MarkdownImportPreview {
  included: PickedFile[];
}

async function analyze(input: PickedFile[]): Promise<Analysis> {
  const violations: ImportViolation[] = [];
  const skipped = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const texts = new Map<string, string>();
  const sources = new Map<string, File>();
  const others = new Map<string, File>();

  for (const { path: rawPath, file } of input) {
    const path = segmentsOf(rawPath).join('/');
    const hidden = hiddenPrefix(path);
    if (hidden) {
      skipped.add(hidden);
    } else if (!isMarkdown(path)) {
      others.set(path, file);
    } else {
      try {
        texts.set(path, decoder.decode(await file.arrayBuffer()));
        sources.set(path, file);
      } catch {
        violations.push({ kind: 'invalidUtf8', path });
      }
    }
  }

  const referenced = new Set<string>();
  let pageCount = 0;
  let tooDeep = false;

  const buildPage = (
    sourcePath: string | null,
    name: string,
    children: PreviewNode[],
  ): PreviewNode => {
    pageCount += 1;
    if (sourcePath === null) return { title: name, children };
    const { title, content } = parsePage(texts.get(sourcePath)!, name);
    if (content.length > MAX_PAGE_CHARACTERS) {
      violations.push({ kind: 'pageLength', path: sourcePath });
    }
    for (const path of referencedPaths(content, sourcePath)) {
      if (others.has(path)) referenced.add(path);
    }
    return { title, children };
  };

  const buildLevel = (folder: Folder, depth: number, ownSource: string | null): PreviewNode[] => {
    const consumed = new Set<string>(ownSource ? [ownSource] : []);
    const items: { name: string; build: () => PreviewNode }[] = [];
    for (const sub of folder.folders.values()) {
      const source = folderContentFile(sub, folder);
      if (source) consumed.add(source);
      items.push({
        name: sub.name,
        build: () => buildPage(source, sub.name, buildLevel(sub, depth + 1, source)),
      });
    }
    for (const file of folder.files) {
      if (consumed.has(file)) continue;
      const name = basename(file).slice(0, -3);
      items.push({ name, build: () => buildPage(file, name, []) });
    }
    if (items.length > 0 && depth > MAX_DEPTH && !tooDeep) {
      tooDeep = true;
      violations.push({ kind: 'depth', path: folder.path });
    }
    items.sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));
    return items.map((item) => item.build());
  };

  const tree = buildLevel(folderTree([...texts.keys()]), 1, null);
  if (pageCount > MAX_PAGES) violations.push({ kind: 'pageCount', count: pageCount });

  const assets = [...others].filter(([path]) => referenced.has(path));
  for (const path of others.keys()) if (!referenced.has(path)) skipped.add(path);

  return {
    tree,
    pageCount,
    assetCount: assets.length,
    skipped: [...skipped].sort(),
    violations,
    included: [
      ...[...sources].map(([path, file]) => ({ path, file })),
      ...assets.map(([path, file]) => ({ path, file })),
    ],
  };
}

// Packs only the pages and the assets they reference, which is what the api imports.
function pack(included: PickedFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const { path, file } of included) zip.file(path, file, { createFolders: false });
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export async function previewMarkdownImport(files: PickedFile[]): Promise<MarkdownImportPreview> {
  const { included, ...preview } = await analyze(files);
  if (included.length > MAX_ENTRIES) {
    preview.violations.push({ kind: 'entryCount' });
  } else if (included.reduce((sum, { file }) => sum + file.size, 0) > MAX_UNPACKED_BYTES) {
    preview.violations.push({ kind: 'unpackedSize' });
  } else if ((await pack(included)).size > MAX_ZIP_BYTES) {
    preview.violations.push({ kind: 'zipSize' });
  }
  return preview;
}

export async function packMarkdownImport(files: PickedFile[]): Promise<Blob> {
  return pack((await analyze(files)).included);
}
