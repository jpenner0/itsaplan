import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { HttpError } from '#shared/lib';
import {
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_PAGES,
  MAX_PAGE_CHARS,
  MAX_UNCOMPRESSED_BYTES,
  MAX_ZIP_BYTES,
  readMarkdownZip,
  rewriteReferences,
  type ImportPage,
} from '../../markdown-import';

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const titles = (pages: ImportPage[]): unknown[] =>
  pages.map((page) =>
    page.children.length ? { [page.title]: titles(page.children) } : page.title,
  );

describe('page tree', () => {
  it('turns folders into parent pages and files into pages', async () => {
    const plan = await readMarkdownZip(
      await zipOf({ 'a.md': 'A', 'guide/setup.md': 'S', 'guide/deep/x.md': 'X' }),
    );
    expect(titles(plan.pages)).toEqual(['a', { guide: [{ deep: ['x'] }, 'setup'] }]);
    expect(plan.pages[1]).toMatchObject({ path: 'guide', content: '' });
  });

  it('takes folder content from index.md, README.md or a sibling <folder>.md', async () => {
    const plan = await readMarkdownZip(
      await zipOf({
        'one/index.md': 'from index',
        'one/README.md': 'readme stays a page',
        'two/readme.md': 'from readme',
        'two/child.md': 'c',
        'three.md': 'from sibling',
        'three/child.md': 'c',
      }),
    );
    const [one, three, two] = plan.pages;
    expect(one).toMatchObject({ title: 'one', path: 'one/index.md', content: 'from index' });
    expect(titles(one.children)).toEqual(['README']);
    expect(two).toMatchObject({ title: 'two', path: 'two/readme.md', content: 'from readme' });
    expect(three).toMatchObject({ title: 'three', path: 'three.md', content: 'from sibling' });
    expect(plan.pages).toHaveLength(3);
  });

  it('sorts siblings naturally by file name', async () => {
    const plan = await readMarkdownZip(
      await zipOf({ '10-ten.md': '', '2-two.md': '', '1-one/x.md': '', 'b.md': '' }),
    );
    expect(plan.pages.map((page) => page.title)).toEqual(['1-one', '2-two', '10-ten', 'b']);
  });

  it('keeps a single wrapping folder as one root page', async () => {
    const plan = await readMarkdownZip(await zipOf({ 'wiki/a.md': '', 'wiki/b.md': '' }));
    expect(titles(plan.pages)).toEqual([{ wiki: ['a', 'b'] }]);
  });
});

describe('frontmatter and title', () => {
  it('reads title and icon and keeps the rest', async () => {
    const plan = await readMarkdownZip(
      await zipOf({
        'page.md': '---\ntitle: Real Title\nicon: "🚀"\ntags: [a, b]\n---\n# Real Title\n\nBody',
      }),
    );
    expect(plan.pages[0]).toMatchObject({
      title: 'Real Title',
      icon: '🚀',
      frontmatter: { tags: ['a', 'b'] },
      content: 'Body',
    });
  });

  it('falls back to the file name and removes only an H1 equal to the title', async () => {
    const plan = await readMarkdownZip(
      await zipOf({ 'Notes.md': '# Notes\nText', 'Other.md': '# Something else\nText' }),
    );
    expect(plan.pages[0]).toMatchObject({ title: 'Notes', content: 'Text', frontmatter: {} });
    expect(plan.pages[1]).toMatchObject({ title: 'Other', content: '# Something else\nText' });
  });

  it('uses the frontmatter title for a folder page', async () => {
    const plan = await readMarkdownZip(
      await zipOf({ 'dir/index.md': '---\ntitle: Folder Title\n---\nX', 'dir/a.md': '' }),
    );
    expect(plan.pages[0]).toMatchObject({ title: 'Folder Title', content: 'X' });
  });

  it('leaves a leading thematic break that is no YAML mapping in the content', async () => {
    const text = '---\njust text\n---\nBody';
    const plan = await readMarkdownZip(await zipOf({ 'p.md': text }));
    expect(plan.pages[0]).toMatchObject({ content: text, frontmatter: {} });
  });

  it('refuses frontmatter over 16 KB', async () => {
    const yaml = `notes: "${'x'.repeat(16_384)}"`;
    const error = await rejection(
      readMarkdownZip(await zipOf({ 'big.md': `---\n${yaml}\n---\n` })),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('big.md');
  });

  it('refuses frontmatter that expands through aliases', async () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (const n of ['b', 'c', 'd', 'e']) {
      const prev = lines.at(-1)!.split(':')[0];
      lines.push(`${n}: &${n} [${Array(10).fill(`*${prev}`).join(', ')}]`);
    }
    const error = await rejection(
      readMarkdownZip(await zipOf({ 'bomb.md': `---\n${lines.join('\n')}\n---\n` })),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('bomb.md');
  });
});

describe('references', () => {
  const page = [
    '![logo](img/logo.png "Logo")',
    '<img alt="x" src="./img/my%20pic.png">',
    '[spec](../docs/spec.pdf)',
    '[other](sub/other.md#part)',
    '![remote](https://example.com/a.png)',
    '[anchor](#top)',
    '[[Wikilink]]',
    '[ref]: img/logo.png',
    '```',
    '![in code](img/logo.png)',
    '```',
  ].join('\n');

  async function plan() {
    return readMarkdownZip(
      await zipOf({
        'notes/page.md': page,
        'notes/img/logo.png': new Uint8Array([1, 2, 3]),
        'notes/img/my pic.png': new Uint8Array([4]),
        'notes/sub/other.md': 'O',
        'docs/spec.pdf': new Uint8Array([5]),
        'notes/img/unused.png': new Uint8Array([6]),
      }),
    );
  }

  it('collects local files and .md links resolved to the page folder', async () => {
    const result = await plan();
    const notes = result.pages.find((p) => p.title === 'notes')!;
    const ref = notes.children.find((p) => p.title === 'page')!;
    expect(ref.assetRefs.sort()).toEqual([
      'docs/spec.pdf',
      'notes/img/logo.png',
      'notes/img/my pic.png',
    ]);
    expect(ref.pageLinks).toEqual(['notes/sub/other.md']);
    expect(result.files.map((f) => [f.path, f.filename, [...f.bytes]])).toEqual([
      ['docs/spec.pdf', 'spec.pdf', [5]],
      ['notes/img/logo.png', 'logo.png', [1, 2, 3]],
      ['notes/img/my pic.png', 'my pic.png', [4]],
    ]);
    expect(result.skipped).toEqual(['notes/img/unused.png']);
  });

  it('rewrites references from a map and leaves the rest unchanged', async () => {
    const result = await plan();
    const ref = result.pages
      .find((p) => p.title === 'notes')!
      .children.find((p) => p.title === 'page')!;
    const urls = new Map([
      ['notes/img/logo.png', '/assets/1'],
      ['notes/img/my pic.png', '/assets/2'],
      ['docs/spec.pdf', '/assets/3'],
      ['notes/sub/other.md', '/docs/9'],
    ]);
    expect(rewriteReferences(ref, urls).split('\n')).toEqual([
      '![logo](/assets/1 "Logo")',
      '<img alt="x" src="/assets/2">',
      '[spec](/assets/3)',
      '[other](/docs/9#part)',
      '![remote](https://example.com/a.png)',
      '[anchor](#top)',
      '[[Wikilink]]',
      '[ref]: /assets/1',
      '```',
      '![in code](img/logo.png)',
      '```',
    ]);
  });
});

describe('skipped files', () => {
  it('skips hidden files and folders', async () => {
    const plan = await readMarkdownZip(
      await zipOf({
        'a.md': '',
        '.git/HEAD': 'x',
        '.obsidian/app.json': '{}',
        '__MACOSX/a.md': '',
        'dir/.DS_Store': 'x',
        'dir/.hidden.md': '',
        'dir/b.md': '',
      }),
    );
    expect(titles(plan.pages)).toEqual(['a', { dir: ['b'] }]);
    expect(plan.skipped).toEqual([
      '.git/',
      '.obsidian/',
      '__MACOSX/',
      'dir/.DS_Store',
      'dir/.hidden.md',
    ]);
  });
});

describe('limits', () => {
  it('accepts the maximum page count and refuses one more', async () => {
    const files = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}.md`, '']));
    const plan = await readMarkdownZip(await zipOf(files(MAX_IMPORT_PAGES)));
    expect(plan.pages).toHaveLength(MAX_IMPORT_PAGES);
    const error = await rejection(readMarkdownZip(await zipOf(files(MAX_IMPORT_PAGES + 1))));
    expect(error.status).toBe(400);
  });

  it('counts folder pages toward the page limit', async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_IMPORT_PAGES / 2 }, (_, i) => [`d${i}/a.md`, '']),
    );
    files['extra.md'] = '';
    const error = await rejection(readMarkdownZip(await zipOf(files)));
    expect(error.status).toBe(400);
  });

  it('accepts a page at the character limit and refuses one more', async () => {
    const plan = await readMarkdownZip(await zipOf({ 'p.md': 'x'.repeat(MAX_PAGE_CHARS) }));
    expect(plan.pages[0].content).toHaveLength(MAX_PAGE_CHARS);
    const error = await rejection(
      readMarkdownZip(await zipOf({ 'big.md': 'x'.repeat(MAX_PAGE_CHARS + 1) })),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('big.md');
  });

  it('accepts the maximum depth and refuses one level more', async () => {
    const nested = (levels: number) =>
      Array.from({ length: levels - 1 }, (_, i) => `d${i}`).join('/') + '/leaf.md';
    const plan = await readMarkdownZip(await zipOf({ [nested(MAX_IMPORT_DEPTH)]: '' }));
    expect(plan.pages).toHaveLength(1);
    const error = await rejection(
      readMarkdownZip(await zipOf({ [nested(MAX_IMPORT_DEPTH + 1)]: '' })),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('leaf.md');
  });

  it('refuses a ZIP over the size limit before reading it', async () => {
    const error = await rejection(readMarkdownZip(new Uint8Array(MAX_ZIP_BYTES + 1)));
    expect(error.status).toBe(413);
  });

  it('stops reading when the uncompressed budget is exceeded', async () => {
    const chunk = new Uint8Array(MAX_UNCOMPRESSED_BYTES / 2 + 1);
    const data = await zipOf({ 'a.md': '![](a.bin)\n![](b.bin)', 'a.bin': chunk, 'b.bin': chunk });
    const error = await rejection(readMarkdownZip(data));
    expect(error.status).toBe(413);
  });

  // Sets the uncompressed size the central directory declares for a.bin.
  function declareSize(data: Uint8Array, size: number): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < data.length - 51; i++) {
      const name = Buffer.from(data.subarray(i + 46, i + 51)).toString();
      if (view.getUint32(i, true) === 0x02014b50 && name === 'a.bin') {
        view.setUint32(i + 24, size, true);
      }
    }
  }

  it('refuses a ZIP whose declared sizes exceed the budget', async () => {
    const data = await zipOf({ 'a.md': '![](a.bin)', 'a.bin': new Uint8Array(10) });
    declareSize(data, MAX_UNCOMPRESSED_BYTES + 1);
    const error = await rejection(readMarkdownZip(data));
    expect(error.status).toBe(413);
  });

  it('counts the real bytes when the declared size lies', async () => {
    const data = await zipOf({
      'a.md': '![](a.bin)',
      'a.bin': new Uint8Array(MAX_UNCOMPRESSED_BYTES + 1),
    });
    declareSize(data, 1);
    const error = await rejection(readMarkdownZip(data));
    expect(error.status).toBe(413);
  });

  it('refuses a file that is not a ZIP', async () => {
    const error = await rejection(readMarkdownZip(new TextEncoder().encode('not a zip')));
    expect(error.status).toBe(400);
  });
});

describe('unsafe input', () => {
  it('names a .md file that is not valid UTF-8', async () => {
    const error = await rejection(
      readMarkdownZip(await zipOf({ 'dir/latin1.md': new Uint8Array([0x63, 0x61, 0xe9]) })),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('dir/latin1.md');
  });

  // jszip refuses to write these names, so they are patched into the archive bytes.
  async function zipWithName(name: string): Promise<Uint8Array> {
    const placeholder = 'x'.repeat(name.length - 3) + '.md';
    const data = await zipOf({ [placeholder]: 'x' });
    const text = Buffer.from(data).toString('latin1').replaceAll(placeholder, name);
    return new Uint8Array(Buffer.from(text, 'latin1'));
  }

  for (const name of [
    '../evil.md',
    'a/../../evil.md',
    '/etc/evil.md',
    'C:/evil.md',
    'a\\evil.md',
  ]) {
    it(`refuses the entry name ${name}`, async () => {
      const error = await rejection(readMarkdownZip(await zipWithName(name)));
      expect(error.status).toBe(400);
      expect(error.message).toContain('unsafe path');
    });
  }
});
