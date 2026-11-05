import { Inflate } from 'fflate';
import { parse as parseYaml } from 'yaml';
import { HttpError } from '#shared/lib';

export const MARKDOWN_IMPORT_LIMITS = {
  zipBytes: 50 * 1024 * 1024,
  uncompressedBytes: 200 * 1024 * 1024,
  entries: 20_000,
  pages: 500,
  pageChars: 250_000,
};

// The Docs tree has no depth limit of its own. This cap keeps an import readable in the sidebar.
export const MARKDOWN_IMPORT_MAX_DEPTH = 10;

const MAX_TITLE_LENGTH = 255;
const MAX_ICON_LENGTH = 64;
// UTF-8 needs at most 3 bytes per UTF-16 code unit, plus 3 for a byte order mark.
const MAX_PAGE_BYTES = MARKDOWN_IMPORT_LIMITS.pageChars * 3 + 3;
// Deflate expands at most about 1032:1, so a larger declared size is a lie.
const MAX_DEFLATE_RATIO = 1032;
// A small slice bounds the output of one inflate step, so the size check stops a bomb early.
const INFLATE_SLICE_BYTES = 4096;

export interface MarkdownImportReference {
  path: string;
  kind: 'page' | 'asset';
}

export interface MarkdownImportPage {
  /** The folder or `.md` file this page stands for. */
  path: string;
  /** The `.md` file the content comes from, `null` for a folder without one. */
  sourcePath: string | null;
  title: string;
  icon: string | null;
  frontmatter: Record<string, unknown>;
  content: string;
  children: MarkdownImportPage[];
  references: MarkdownImportReference[];
}

export interface MarkdownImportAsset {
  path: string;
  filename: string;
  bytes: Uint8Array;
}

export interface MarkdownImportPlan {
  pages: MarkdownImportPage[];
  assets: MarkdownImportAsset[];
  skipped: string[];
}

interface ZipEntry {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  dataOffset: number;
}

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Lenient = new TextDecoder('utf-8');

/**
 * `maxDepth` is the number of page levels the import may create below its target: 1 allows
 * top-level pages only.
 */
export function parseMarkdownZip(
  bytes: Uint8Array,
  opts: { maxDepth: number },
): MarkdownImportPlan {
  if (bytes.length > MARKDOWN_IMPORT_LIMITS.zipBytes) {
    throw new HttpError(413, 'The ZIP file is larger than 50 MB.');
  }
  const markdown = new Map<string, ZipEntry>();
  const others = new Map<string, ZipEntry>();
  const skipped = new Set<string>();
  for (const entry of readCentralDirectory(bytes)) {
    const hidden = hiddenPrefix(entry.path);
    if (hidden) skipped.add(hidden);
    else if (entry.path.toLowerCase().endsWith('.md')) markdown.set(entry.path, entry);
    else others.set(entry.path, entry);
  }

  const budget = { used: 0 };
  const isFile = (path: string) => markdown.has(path) || others.has(path);
  const referenced = new Set<string>();
  let pageCount = 0;

  const buildPage = (
    path: string,
    sourcePath: string | null,
    name: string,
    children: MarkdownImportPage[],
  ): MarkdownImportPage => {
    pageCount += 1;
    if (pageCount > MARKDOWN_IMPORT_LIMITS.pages) {
      throw new HttpError(413, `The import has more than ${MARKDOWN_IMPORT_LIMITS.pages} pages.`);
    }
    if (sourcePath === null) {
      return {
        path,
        sourcePath,
        title: name,
        icon: null,
        frontmatter: {},
        content: '',
        children,
        references: [],
      };
    }
    const entry = markdown.get(sourcePath)!;
    const tooLong = new HttpError(
      413,
      `"${sourcePath}" has more than ${MARKDOWN_IMPORT_LIMITS.pageChars} characters.`,
    );
    if (entry.size > MAX_PAGE_BYTES) throw tooLong;
    const text = decodeUtf8(inflateEntry(bytes, entry, budget), sourcePath);
    if (text.length > MARKDOWN_IMPORT_LIMITS.pageChars) throw tooLong;
    const page = parsePage(text, name);
    const references = new Map<string, MarkdownImportReference>();
    for (const match of scanReferences(page.content, sourcePath, isFile)) {
      const kind = markdown.has(match.path) ? 'page' : 'asset';
      references.set(match.path, { path: match.path, kind });
      if (kind === 'asset') referenced.add(match.path);
    }
    return { path, sourcePath, ...page, children, references: [...references.values()] };
  };

  const buildLevel = (
    folder: Folder,
    depth: number,
    ownSource: string | null,
  ): MarkdownImportPage[] => {
    const consumed = new Set<string>(ownSource ? [ownSource] : []);
    const items: { name: string; build: () => MarkdownImportPage }[] = [];
    for (const sub of folder.folders.values()) {
      const source = folderContentFile(sub, folder);
      if (source) consumed.add(source);
      items.push({
        name: sub.name,
        build: () => buildPage(sub.path, source, sub.name, buildLevel(sub, depth + 1, source)),
      });
    }
    for (const file of folder.files) {
      if (consumed.has(file)) continue;
      const name = basename(file).slice(0, -3);
      items.push({ name, build: () => buildPage(file, file, name, []) });
    }
    if (items.length > 0 && depth > opts.maxDepth) {
      throw new HttpError(400, `"${folder.path}" is nested deeper than ${opts.maxDepth} levels.`);
    }
    items.sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));
    return items.map((item) => item.build());
  };

  const pages = buildLevel(folderTree([...markdown.keys()]), 1, null);

  const assets: MarkdownImportAsset[] = [];
  for (const [path, entry] of [...others].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!referenced.has(path)) skipped.add(path);
    else assets.push({ path, filename: basename(path), bytes: inflateEntry(bytes, entry, budget) });
  }
  return { pages, assets, skipped: [...skipped].sort() };
}

/**
 * Replaces each local reference whose resolved path is a key of `urls`. A page link keeps its
 * `#fragment`. Everything else stays as written.
 */
export function rewriteMarkdownReferences(
  content: string,
  sourcePath: string,
  urls: ReadonlyMap<string, string>,
): string {
  let result = content;
  const matches = scanReferences(content, sourcePath, (path) => urls.has(path));
  for (const match of matches.reverse()) {
    const url = urls.get(match.path)! + match.fragment;
    result = result.slice(0, match.start) + url + result.slice(match.end);
  }
  return result;
}

function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new HttpError(400, 'ZIP64 archives are not supported.');
  }
  if (count > MARKDOWN_IMPORT_LIMITS.entries) {
    throw new HttpError(
      413,
      `The ZIP file has more than ${MARKDOWN_IMPORT_LIMITS.entries} entries.`,
    );
  }
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw corrupt();
    }
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) throw corrupt();
    const rawName = utf8Lenient.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const entry = {
      method: view.getUint16(offset + 10, true),
      crc: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    };
    offset = next;
    const path = normalizeEntryPath(rawName);
    if (rawName.endsWith('/') || rawName.endsWith('\\') || path === '') continue;
    if (seen.has(path)) throw new HttpError(400, `"${path}" appears twice in the ZIP file.`);
    seen.add(path);
    if (flags & 1) throw new HttpError(400, `"${path}" is encrypted.`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new HttpError(400, `"${path}" uses an unsupported compression method.`);
    }
    const local = entry.localOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw corrupt();
    const dataOffset =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataOffset + entry.compressedSize > bytes.length) throw corrupt();
    entries.push({ path, ...entry, dataOffset });
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new HttpError(400, 'The file is not a ZIP archive.');
}

function corrupt(): HttpError {
  return new HttpError(400, 'The ZIP file is damaged.');
}

function normalizeEntryPath(raw: string): string {
  const name = raw.replaceAll('\\', '/');
  // eslint-disable-next-line no-control-regex
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new HttpError(400, `"${raw}" is not a relative path.`);
  }
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new HttpError(400, `"${raw}" points outside the folder.`);
  }
  return segments.join('/');
}

function hiddenPrefix(path: string): string | null {
  const segments = path.split('/');
  const index = segments.findIndex((s) => s.startsWith('.') || s === '__MACOSX');
  if (index === -1) return null;
  const prefix = segments.slice(0, index + 1).join('/');
  return index === segments.length - 1 ? prefix : `${prefix}/`;
}

function inflateEntry(bytes: Uint8Array, entry: ZipEntry, budget: { used: number }): Uint8Array {
  if (budget.used + entry.size > MARKDOWN_IMPORT_LIMITS.uncompressedBytes) {
    throw new HttpError(413, 'The files in the ZIP file are larger than 200 MB in total.');
  }
  budget.used += entry.size;
  const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw damaged(entry);
    out = data.slice();
  } else {
    if (entry.size > entry.compressedSize * MAX_DEFLATE_RATIO) throw damaged(entry);
    const chunks: Uint8Array[] = [];
    let written = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      if (written + chunk.length > entry.size) throw damaged(entry);
      chunks.push(chunk);
      written += chunk.length;
      finished = final;
    });
    try {
      let offset = 0;
      do {
        const next = offset + INFLATE_SLICE_BYTES;
        inflater.push(data.subarray(offset, next), next >= data.length);
        offset = next;
      } while (offset < data.length);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw damaged(entry);
    }
    if (!finished || written !== entry.size) throw damaged(entry);
    out = new Uint8Array(written);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
  }
  if (Bun.hash.crc32(out) !== entry.crc) throw damaged(entry);
  return out;
}

function damaged(entry: ZipEntry): HttpError {
  return new HttpError(400, `"${entry.path}" is damaged in the ZIP file.`);
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new HttpError(400, `"${path}" is not valid UTF-8.`);
  }
}

function folderTree(paths: string[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const path of paths) {
    const segments = path.split('/');
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
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

/** `index.md`, then `README.md` inside the folder, then a sibling `<folder>.md`. */
function folderContentFile(folder: Folder, parent: Folder): string | null {
  for (const wanted of ['index.md', 'readme.md']) {
    const match = folder.files.filter((file) => basename(file).toLowerCase() === wanted).sort()[0];
    if (match) return match;
  }
  return parent.files.find((file) => basename(file).slice(0, -3) === folder.name) ?? null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const ATX_H1 = /^# +(.*?)(?: +#+)? *(?:\n|$)/;

function parsePage(
  text: string,
  fallbackTitle: string,
): Pick<MarkdownImportPage, 'title' | 'icon' | 'frontmatter' | 'content'> {
  let content = text.replace(/\r\n?/g, '\n');
  let frontmatter: Record<string, unknown> = {};
  const block = FRONTMATTER.exec(content);
  const data = block ? parseFrontmatter(block[1] ?? '') : null;
  if (block && data) {
    frontmatter = data;
    content = content.slice(block[0].length);
  }

  let icon: string | null = null;
  if (typeof frontmatter.icon === 'string') {
    const value = frontmatter.icon.trim();
    if (value && value.length <= MAX_ICON_LENGTH) {
      icon = value;
      const { icon: _icon, ...rest } = frontmatter;
      frontmatter = rest;
    }
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
  return { title, icon, frontmatter, content };
}

/** A block that is not a YAML mapping stays in the content, so a leading `---` rule survives. */
function parseFrontmatter(source: string): Record<string, unknown> | null {
  if (source.trim() === '') return {};
  try {
    const value: unknown = parseYaml(source, { schema: 'core' });
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Fall through: the block is not frontmatter.
  }
  return null;
}

interface ReferenceMatch {
  start: number;
  end: number;
  path: string;
  fragment: string;
}

const MARKDOWN_LINK = /\]\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)/g;
const HTML_IMG = /<img\b[^<>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;

function scanReferences(
  content: string,
  sourcePath: string,
  isFile: (path: string) => boolean,
): ReferenceMatch[] {
  const text = maskCode(content);
  const candidates: { start: number; raw: string }[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    candidates.push({ start: m.index + m[0].length - m[1].length, raw: m[1] });
  }
  for (const m of text.matchAll(HTML_IMG)) {
    const raw = m[1] ?? m[2] ?? m[3];
    const quoted = m[3] === undefined ? 1 : 0;
    candidates.push({ start: m.index + m[0].length - raw.length - quoted, raw });
  }
  const matches: ReferenceMatch[] = [];
  for (const { start, raw } of candidates) {
    const resolved = resolveReference(raw, sourcePath);
    if (resolved && isFile(resolved.path)) {
      matches.push({ start, end: start + raw.length, ...resolved });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Replaces fenced code blocks and inline code spans with spaces of the same length, so the
 * reference scan skips them and the indices still match `content`.
 */
function maskCode(content: string): string {
  const text = content.replace(FENCED_CODE, (block) => block.replace(/[^\n]/g, ' '));
  // A code span runs to the next backtick run of the same length in the same paragraph. Indexing
  // the next such run keeps this linear on pages with many unmatched backticks.
  const runs = [...text.matchAll(/`+/g)];
  const blankLines = [...text.matchAll(/\n[ \t]*\n/g)].map((m) => m.index);
  const runKeys: string[] = [];
  for (let i = 0, paragraph = 0; i < runs.length; i += 1) {
    while (paragraph < blankLines.length && blankLines[paragraph] < runs[i].index) paragraph += 1;
    runKeys.push(`${paragraph}:${runs[i][0].length}`);
  }
  const nextSameLength: number[] = [];
  const latest = new Map<string, number>();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    nextSameLength[i] = latest.get(runKeys[i]) ?? -1;
    latest.set(runKeys[i], i);
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

function resolveReference(
  raw: string,
  sourcePath: string,
): { path: string; fragment: string } | null {
  const url = raw.startsWith('<') ? raw.slice(1, -1).trim() : raw;
  if (url === '' || /^[a-z][a-z\d+.-]*:/i.test(url) || /^[/#?]/.test(url)) return null;
  const hash = url.indexOf('#');
  const fragment = hash === -1 ? '' : url.slice(hash);
  const target = url.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
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
  return segments.length > 0 ? { path: segments.join('/'), fragment } : null;
}
