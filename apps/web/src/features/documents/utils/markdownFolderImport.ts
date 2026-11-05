import JSZip from 'jszip';

// Mirror the api's import limits and mapping rules; the preview must match what the api creates.
// The api puts no limit on how deep the page tree nests, so there is no depth limit here.
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_PAGE_CHARACTERS = 250_000;

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
  | { kind: 'pageCount'; count: number }
  | { kind: 'pageLength'; path: string }
  | { kind: 'invalidUtf8'; path: string };

export interface MarkdownImportPreview {
  tree: PreviewNode[];
  pageCount: number;
  assetCount: number;
  skipped: string[];
  violations: ImportViolation[];
}

interface Page {
  name: string;
  path: string;
  title: string | null;
  body: string;
}

interface Folder {
  folders: Map<string, Folder>;
  pages: Map<string, Page>;
}

const collator = new Intl.Collator(undefined, { numeric: true });
const isMarkdown = (name: string) => /\.md$/i.test(name);
const withoutExtension = (name: string) => name.replace(/\.md$/i, '');
const segmentsOf = (path: string) => path.split('/').filter(Boolean);
const isHidden = (segments: string[]) =>
  segments.some((segment) => segment.startsWith('.') || segment === '__MACOSX');

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
  const files: PickedFile[] = [];
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const blob = await entry.async('blob');
    total += blob.size;
    if (total > MAX_ZIP_BYTES) return { files: [], violations: [{ kind: 'zipSize' }] };
    files.push({ path: entry.name, file: new File([blob], entry.name.split('/').pop() ?? '') });
  }
  return { files, violations: [] };
}

function splitFrontmatter(text: string): { title: string | null; body: string } {
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { title: null, body: text };
  const raw = /^title:[ \t]*(.*?)[ \t]*$/m.exec(match[1] ?? '')?.[1] ?? '';
  const title = raw.replace(/^(["'])(.*)\1$/, '$2').trim();
  return { title: title || null, body: text.slice(match[0].length) };
}

const REFERENCE = /\]\(\s*(<[^>]*>|[^)\s]*)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

function referencedPaths(page: Page): string[] {
  const dir = segmentsOf(page.path).slice(0, -1);
  const found: string[] = [];
  for (const match of page.body.matchAll(REFERENCE)) {
    const target = (match[1] ?? match[2] ?? '').replace(/^<|>$/g, '');
    const bare = target.split(/[#?]/)[0];
    if (!bare || EXTERNAL.test(bare)) continue;
    let decoded = bare;
    try {
      decoded = decodeURIComponent(bare);
    } catch {
      // keep the raw text when it is not valid percent-encoding
    }
    const resolved = [...dir];
    for (const segment of decoded.split('/')) {
      if (segment === '..') resolved.pop();
      else if (segment && segment !== '.') resolved.push(segment);
    }
    found.push(resolved.join('/'));
  }
  return found;
}

function addPage(root: Folder, page: Page) {
  let folder = root;
  for (const name of segmentsOf(page.path).slice(0, -1)) {
    let next = folder.folders.get(name);
    if (!next) {
      next = { folders: new Map(), pages: new Map() };
      folder.folders.set(name, next);
    }
    folder = next;
  }
  folder.pages.set(page.name, page);
}

const hasPages = (folder: Folder): boolean =>
  folder.pages.size > 0 || [...folder.folders.values()].some(hasPages);

function folderContent(parent: Folder, name: string, folder: Folder): Page | undefined {
  const lower = (page: Page) => page.name.toLowerCase();
  const pages = [...folder.pages.values()];
  return (
    pages.find((page) => lower(page) === 'index.md') ??
    pages.find((page) => lower(page) === 'readme.md') ??
    [...parent.pages.values()].find((page) => lower(page) === `${name.toLowerCase()}.md`)
  );
}

function buildTree(folder: Folder, claimed: Set<Page>): PreviewNode[] {
  const entries: Array<{ name: string; node: PreviewNode }> = [];
  const contents = new Map<string, Page | undefined>();
  for (const [name, child] of folder.folders) {
    if (!hasPages(child)) continue;
    const content = folderContent(folder, name, child);
    if (content) claimed.add(content);
    contents.set(name, content);
  }
  for (const [name, child] of folder.folders) {
    if (!contents.has(name)) continue;
    entries.push({
      name,
      node: { title: contents.get(name)?.title ?? name, children: buildTree(child, claimed) },
    });
  }
  for (const page of folder.pages.values()) {
    if (claimed.has(page)) continue;
    entries.push({
      name: withoutExtension(page.name),
      node: { title: page.title ?? withoutExtension(page.name), children: [] },
    });
  }
  return entries.sort((a, b) => collator.compare(a.name, b.name)).map(({ node }) => node);
}

const countNodes = (nodes: PreviewNode[]): number =>
  nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);

interface Analysis extends MarkdownImportPreview {
  included: PickedFile[];
}

async function analyze(input: PickedFile[]): Promise<Analysis> {
  const violations: ImportViolation[] = [];
  const skipped: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const root: Folder = { folders: new Map(), pages: new Map() };
  const markdown: Array<{ page: Page; source: PickedFile }> = [];
  const others = new Map<string, PickedFile>();

  if (input.reduce((sum, { file }) => sum + file.size, 0) > MAX_ZIP_BYTES) {
    violations.push({ kind: 'zipSize' });
  }

  for (const source of input) {
    const path = segmentsOf(source.path).join('/');
    if (isHidden(segmentsOf(path))) {
      skipped.push(path);
    } else if (!isMarkdown(path)) {
      others.set(path, source);
    } else {
      let text: string;
      try {
        text = decoder.decode(await source.file.arrayBuffer());
      } catch {
        violations.push({ kind: 'invalidUtf8', path });
        continue;
      }
      const { title, body } = splitFrontmatter(text);
      if (body.length > MAX_PAGE_CHARACTERS) violations.push({ kind: 'pageLength', path });
      const page = { name: path.split('/').pop() ?? path, path, title, body };
      addPage(root, page);
      markdown.push({ page, source });
    }
  }

  const tree = buildTree(root, new Set());
  const pageCount = countNodes(tree);
  if (pageCount > MAX_PAGES) violations.push({ kind: 'pageCount', count: pageCount });

  const referenced = new Set<string>();
  for (const { page } of markdown) {
    for (const path of referencedPaths(page)) if (others.has(path)) referenced.add(path);
  }
  for (const path of others.keys()) if (!referenced.has(path)) skipped.push(path);

  return {
    tree,
    pageCount,
    assetCount: referenced.size,
    skipped,
    violations,
    included: [
      ...markdown.map(({ page, source }) => ({ path: page.path, file: source.file })),
      ...[...referenced].map((path) => ({ path, file: others.get(path)!.file })),
    ],
  };
}

export async function previewMarkdownImport(files: PickedFile[]): Promise<MarkdownImportPreview> {
  const { included: _included, ...preview } = await analyze(files);
  return preview;
}

// Packs only the pages and the assets they reference, which is what the api imports.
export async function packMarkdownImport(files: PickedFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const { path, file } of (await analyze(files)).included) zip.file(path, file);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
