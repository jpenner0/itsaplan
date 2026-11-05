import { describe, expect, it } from 'bun:test';
import { zipSync, type Zippable } from 'fflate';
import { HttpError } from '#shared/lib';
import {
  MARKDOWN_IMPORT_LIMITS,
  MARKDOWN_IMPORT_MAX_DEPTH,
  parseMarkdownZip,
  rewriteMarkdownReferences,
  type MarkdownImportPage,
} from '../../markdown-import';

const encoder = new TextEncoder();
const opts = { maxDepth: MARKDOWN_IMPORT_MAX_DEPTH };

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const input: Zippable = {};
  for (const [name, value] of Object.entries(files)) {
    input[name] = typeof value === 'string' ? encoder.encode(value) : value;
  }
  return zipSync(input);
}

function parse(files: Record<string, string | Uint8Array>, maxDepth = opts.maxDepth) {
  return parseMarkdownZip(zip(files), { maxDepth });
}

function failure(run: () => unknown): HttpError {
  try {
    run();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('did not throw');
}

function outline(pages: MarkdownImportPage[]): unknown[] {
  return pages.map((page) =>
    page.children.length > 0 ? { [page.title]: outline(page.children) } : page.title,
  );
}

/** Sets the declared uncompressed size of the first entry in the central directory. */
function withDeclaredSize(bytes: Uint8Array, size: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return bytes;
    }
  }
  throw new Error('no central directory');
}

describe('parseMarkdownZip: tree', () => {
  it('turns nested folders into nested pages', () => {
    const plan = parse({
      'Guide/Setup/Install.md': 'install',
      'Guide/Intro.md': 'intro',
      'Top.md': 'top',
    });
    expect(outline(plan.pages)).toEqual([{ Guide: ['Intro', { Setup: ['Install'] }] }, 'Top']);
    expect(plan.pages[0]).toMatchObject({ path: 'Guide', sourcePath: null, content: '' });
    expect(plan.pages[0].children[1].children[0]).toMatchObject({
      path: 'Guide/Setup/Install.md',
      sourcePath: 'Guide/Setup/Install.md',
      content: 'install',
    });
  });

  it('takes folder content from index.md, README.md or a sibling <folder>.md', () => {
    const plan = parse({
      'A/index.md': 'from index',
      'A/README.md': 'readme stays a page',
      'B/ReadMe.md': 'from readme',
      'B/child.md': 'x',
      'C.md': 'from sibling',
      'C/child.md': 'x',
      'D/child.md': 'x',
    });
    const [a, b, c, d] = plan.pages;
    expect(a).toMatchObject({ title: 'A', sourcePath: 'A/index.md', content: 'from index' });
    expect(outline(a.children)).toEqual(['README']);
    expect(b).toMatchObject({ title: 'B', sourcePath: 'B/ReadMe.md', content: 'from readme' });
    expect(outline(b.children)).toEqual(['child']);
    expect(c).toMatchObject({ title: 'C', sourcePath: 'C.md', content: 'from sibling' });
    expect(d).toMatchObject({ title: 'D', sourcePath: null, content: '' });
    expect(plan.pages).toHaveLength(4);
  });

  it('does not make a page of a folder without Markdown files', () => {
    const plan = parse({ 'page.md': '![](img/a.png)', 'img/a.png': 'png' });
    expect(outline(plan.pages)).toEqual(['page']);
  });

  it('sorts siblings naturally', () => {
    const plan = parse({
      '10-ten.md': '',
      '2-two.md': '',
      '1-one/x.md': '',
      'b.md': '',
      'A.md': '',
    });
    expect(outline(plan.pages)).toEqual([{ '1-one': ['x'] }, '2-two', '10-ten', 'A', 'b']);
  });
});

describe('parseMarkdownZip: page content', () => {
  it('reads title and icon from frontmatter and keeps the rest', () => {
    const [page] = parse({
      'file.md': '---\ntitle: Real title\nicon: 🚀\ntags: [a, b]\n---\n# Real title\n\nBody',
    }).pages;
    expect(page).toMatchObject({
      title: 'Real title',
      icon: '🚀',
      frontmatter: { title: 'Real title', tags: ['a', 'b'] },
      content: 'Body',
    });
  });

  it('uses the file name as title and removes an equal H1 only', () => {
    const plan = parse({
      'Same.md': '# Same\n\ntext',
      'Other.md': '# Different\n\ntext',
      'Crlf.md': '---\r\nkey: 1\r\n---\r\n# Crlf\r\nline',
    });
    expect(plan.pages.map((p) => [p.title, p.content])).toEqual([
      ['Crlf', 'line'],
      ['Other', '# Different\n\ntext'],
      ['Same', 'text'],
    ]);
    expect(plan.pages[0].frontmatter).toEqual({ key: 1 });
  });

  it('keeps a leading block that is not a YAML mapping in the content', () => {
    const [page] = parse({ 'a.md': '---\njust a line\n---\ntext' }).pages;
    expect(page.frontmatter).toEqual({});
    expect(page.content).toBe('---\njust a line\n---\ntext');
  });

  it('names the file that is not valid UTF-8', () => {
    const err = failure(() => parse({ 'dir/bad.md': new Uint8Array([0x61, 0xff, 0x62]) }));
    expect(err.status).toBe(400);
    expect(err.message).toContain('dir/bad.md');
  });
});

describe('parseMarkdownZip: references', () => {
  const files = {
    'docs/page.md': [
      '![shot](../img/shot%201.png "Title")',
      '[next](sub/next.md#part)',
      '[up](../root.md)',
      '<img alt="x" src="../img/logo.svg">',
      '[web](https://example.com/a.png) [mail](mailto:a@b.c) [proto](//cdn/a.png)',
      '![data](data:image/png;base64,AAA) [anchor](#top) [missing](nope.png)',
      '[[Wikilink]] `![code](../img/code.png)`',
      '```\n![fenced](../img/code.png)\n```',
    ].join('\n'),
    'docs/sub/next.md': 'next',
    'root.md': 'root',
    'img/shot 1.png': 'png',
    'img/logo.svg': 'svg',
    'img/code.png': 'code',
    'img/unused.png': 'unused',
  };

  it('lists local images, files and page links', () => {
    const plan = parse(files);
    const page = plan.pages[0].children.find((p) => p.path === 'docs/page.md')!;
    expect(page.references).toEqual([
      { path: 'img/shot 1.png', kind: 'asset' },
      { path: 'docs/sub/next.md', kind: 'page' },
      { path: 'root.md', kind: 'page' },
      { path: 'img/logo.svg', kind: 'asset' },
    ]);
    expect(plan.assets.map((a) => [a.path, a.filename, new TextDecoder().decode(a.bytes)])).toEqual(
      [
        ['img/logo.svg', 'logo.svg', 'svg'],
        ['img/shot 1.png', 'shot 1.png', 'png'],
      ],
    );
    expect(plan.skipped).toEqual(['img/code.png', 'img/unused.png']);
  });

  it('ignores references in code spans with longer backtick runs', () => {
    const [page] = parse({ 'a.md': '``![x](b.png) ` ``\n![y](b.png)', 'b.png': 'png' }).pages;
    const urls = new Map([['b.png', '/new']]);
    expect(rewriteMarkdownReferences(page.content, 'a.md', urls)).toBe(
      '``![x](b.png) ` ``\n![y](/new)',
    );
  });

  for (const [name, hostile] of [
    [
      'unmatched backtick runs',
      () => {
        let text = '';
        for (let length = 2; text.length < 120_000; length += 1) text += `${'`'.repeat(length)}a`;
        return text;
      },
    ],
    ['unclosed img tags', () => '<img a '.repeat(34_000)],
  ] as const) {
    it(`scans a page of ${name} in linear time`, () => {
      const content = `${hostile()} [x](b.png)`;
      const started = performance.now();
      const [page] = parse({ 'a.md': content, 'b.png': 'png' }).pages;
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(page.references).toEqual([{ path: 'b.png', kind: 'asset' }]);
    });
  }

  it('ends a code span at a blank line', () => {
    const [page] = parse({
      'a.md': 'Don`t\n\n![a](b.png)\n\nA `code` span',
      'b.png': 'png',
    }).pages;
    expect(page.references).toEqual([{ path: 'b.png', kind: 'asset' }]);
  });

  it('rewrites only the references in the map and keeps everything else', () => {
    const plan = parse(files);
    const page = plan.pages[0].children.find((p) => p.path === 'docs/page.md')!;
    const urls = new Map([
      ['img/shot 1.png', '/api/a/1'],
      ['docs/sub/next.md', '/docs/2'],
      ['img/logo.svg', '/api/a/3'],
    ]);
    const result = rewriteMarkdownReferences(page.content, page.sourcePath!, urls);
    expect(result.split('\n').slice(0, 4)).toEqual([
      '![shot](/api/a/1 "Title")',
      '[next](/docs/2#part)',
      '[up](../root.md)',
      '<img alt="x" src="/api/a/3">',
    ]);
    expect(result.split('\n').slice(4)).toEqual(page.content.split('\n').slice(4));
  });
});

describe('parseMarkdownZip: skipped files', () => {
  it('skips hidden files and folders and unreferenced files', () => {
    const plan = parse({
      'a.md': 'a',
      '.obsidian/app.json': '{}',
      '.obsidian/deep/x.md': 'x',
      'dir/.DS_Store': '',
      '__MACOSX/a.md': '',
      'notes.txt': 'x',
    });
    expect(outline(plan.pages)).toEqual(['a']);
    expect(plan.skipped).toEqual(['.obsidian/', '__MACOSX/', 'dir/.DS_Store', 'notes.txt']);
  });
});

describe('parseMarkdownZip: paths', () => {
  it('normalises backslashes', () => {
    expect(outline(parse({ 'dir\\a.md': 'a' }).pages)).toEqual([{ dir: ['a'] }]);
  });

  for (const name of [
    '../evil.md',
    'a/../../evil.md',
    '..\\evil.md',
    '/etc/evil.md',
    'C:/evil.md',
    'C:\\evil.md',
  ]) {
    it(`rejects ${name}`, () => {
      const err = failure(() => parse({ [name]: 'x' }));
      expect(err.status).toBe(400);
      expect(err.message).toContain(name);
    });
  }

  it('rejects a file that is not a ZIP', () => {
    expect(failure(() => parseMarkdownZip(encoder.encode('plain text'), opts)).status).toBe(400);
  });
});

describe('parseMarkdownZip: limits', () => {
  it('accepts a 50 MB ZIP and rejects one byte more', () => {
    const overhead = zipSync({ 'big.bin': [new Uint8Array(0), { level: 0 }] }).length;
    const stored = zipSync({
      'big.bin': [new Uint8Array(MARKDOWN_IMPORT_LIMITS.zipBytes - overhead), { level: 0 }],
    });
    expect(stored.length).toBe(MARKDOWN_IMPORT_LIMITS.zipBytes);
    expect(parseMarkdownZip(stored, opts).skipped).toEqual(['big.bin']);
    const err = failure(() =>
      parseMarkdownZip(new Uint8Array(MARKDOWN_IMPORT_LIMITS.zipBytes + 1), opts),
    );
    expect(err.status).toBe(413);
  });

  it('accepts the entry limit and rejects one more', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MARKDOWN_IMPORT_LIMITS.entries; i += 1) files[`.hidden/${i}`] = '';
    expect(parse(files).skipped).toEqual(['.hidden/']);
    files['.hidden/extra'] = '';
    expect(failure(() => parse(files)).status).toBe(413);
  });

  it('accepts 500 pages and rejects 501', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MARKDOWN_IMPORT_LIMITS.pages - 1; i += 1) files[`folder/${i}.md`] = '';
    expect(parse(files).pages[0].children).toHaveLength(MARKDOWN_IMPORT_LIMITS.pages - 1);
    files['extra.md'] = '';
    expect(failure(() => parse(files)).status).toBe(413);
  });

  it('accepts 250,000 characters per page and rejects one more', () => {
    const max = 'x'.repeat(MARKDOWN_IMPORT_LIMITS.pageChars);
    expect(parse({ 'a.md': max }).pages[0].content).toHaveLength(MARKDOWN_IMPORT_LIMITS.pageChars);
    const err = failure(() => parse({ 'dir/a.md': `${max}x` }));
    expect(err.status).toBe(413);
    expect(err.message).toContain('dir/a.md');
  });

  it('counts the frontmatter toward the page limit', () => {
    const frontmatter = '---\nkey: value\n---\n';
    const body = 'x'.repeat(MARKDOWN_IMPORT_LIMITS.pageChars - frontmatter.length);
    expect(parse({ 'a.md': frontmatter + body }).pages[0].content).toBe(body);
    const err = failure(() => parse({ 'dir/a.md': `${frontmatter}${body}x` }));
    expect(err.status).toBe(413);
    expect(err.message).toContain('dir/a.md');
  });

  it('rejects a Markdown file whose declared size cannot fit the page limit', () => {
    const maxBytes = MARKDOWN_IMPORT_LIMITS.pageChars * 3 + 3;
    const bytes = withDeclaredSize(zip({ 'a.md': 'x'.repeat(1_000) }), maxBytes + 1);
    const err = failure(() => parseMarkdownZip(bytes, opts));
    expect(err.status).toBe(413);
    expect(err.message).toContain('a.md');
  });

  it('accepts the maximum depth and rejects one level more', () => {
    expect(outline(parse({ 'a/b.md': '' }, 2).pages)).toEqual([{ a: ['b'] }]);
    const err = failure(() => parse({ 'a/b/c.md': '' }, 2));
    expect(err.status).toBe(400);
    expect(err.message).toContain('a/b');
  });

  it('accepts the total uncompressed size and rejects one byte more', () => {
    // The budget uses declared sizes, so no 200 MB is inflated. At the limit the entry passes
    // the budget and then fails as damaged (400).
    const page = '![](big.bin)';
    const declare = (size: number) => withDeclaredSize(zip({ 'big.bin': 'x', 'a.md': page }), size);
    const atLimit = MARKDOWN_IMPORT_LIMITS.uncompressedBytes - page.length;
    expect(failure(() => parseMarkdownZip(declare(atLimit), opts)).status).toBe(400);
    expect(failure(() => parseMarkdownZip(declare(atLimit + 1), opts)).status).toBe(413);
  });

  it('rejects a declared size over the limit before inflating', () => {
    const bytes = withDeclaredSize(
      zip({ 'a.md': 'a' }),
      MARKDOWN_IMPORT_LIMITS.uncompressedBytes + 1,
    );
    expect(failure(() => parseMarkdownZip(bytes, opts)).status).toBe(413);
  });

  it('rejects a declared size its compressed data cannot produce', () => {
    const bytes = withDeclaredSize(zip({ 'a.bin': 'x', 'a.md': '![](a.bin)' }), 10_000_000);
    const err = failure(() => parseMarkdownZip(bytes, opts));
    expect(err.status).toBe(400);
    expect(err.message).toContain('a.bin');
  });

  it('stops inflating an entry that is larger than declared', () => {
    const bomb = withDeclaredSize(zip({ 'a.md': new Uint8Array(10 * 1024 * 1024) }), 10);
    const err = failure(() => parseMarkdownZip(bomb, opts));
    expect(err.status).toBe(400);
    expect(err.message).toContain('a.md');
  });
});
