import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import JSZip from 'jszip';
import {
  dropCommonRoot,
  packMarkdownImport,
  pickedFolderFiles,
  previewMarkdownImport,
  readMarkdownZip,
  type PickedFile,
} from './markdownFolderImport';

const pick = (files: Record<string, string | Uint8Array>): PickedFile[] =>
  Object.entries(files).map(([path, content]) => ({
    path,
    file: new File([content as BlobPart], path.split('/').pop() ?? path),
  }));

const titles = (nodes: Array<{ title: string; children: unknown[] }>): unknown[] =>
  nodes.map((node) => [node.title, titles(node.children as typeof nodes)]);

describe('previewMarkdownImport', () => {
  test('builds nested pages from nested folders', async () => {
    const preview = await previewMarkdownImport(
      pick({ 'a.md': '', 'guide/b.md': '', 'guide/deep/c.md': '' }),
    );
    assert.deepEqual(titles(preview.tree), [
      ['a', []],
      [
        'guide',
        [
          ['b', []],
          ['deep', [['c', []]]],
        ],
      ],
    ]);
    assert.equal(preview.pageCount, 5);
  });

  test('uses index.md, README.md or a sibling file as the folder content', async () => {
    const preview = await previewMarkdownImport(
      pick({
        'one/INDEX.md': '---\ntitle: One page\n---\nbody',
        'one/x.md': '',
        'two/readme.md': '',
        'two/y.md': '',
        'three.md': '---\ntitle: "Three page"\n---',
        'three/z.md': '',
        'four/w.md': '',
      }),
    );
    assert.deepEqual(titles(preview.tree), [
      ['four', [['w', []]]],
      ['One page', [['x', []]]],
      ['Three page', [['z', []]]],
      ['two', [['y', []]]],
    ]);
    assert.equal(preview.pageCount, 8);
  });

  test('takes the title from frontmatter, else the file name', async () => {
    const preview = await previewMarkdownImport(
      pick({
        'a.md': '---\ntitle: Real title\n---\n# x',
        'b.md': '---\nother: 1\n---',
        'c.md': '',
      }),
    );
    assert.deepEqual(titles(preview.tree), [
      ['Real title', []],
      ['b', []],
      ['c', []],
    ]);
  });

  test('sorts siblings naturally', async () => {
    const preview = await previewMarkdownImport(
      pick({ '10-b.md': '', '2-a.md': '', '1-z/q.md': '' }),
    );
    assert.deepEqual(
      preview.tree.map((node) => node.title),
      ['1-z', '2-a', '10-b'],
    );
  });

  test('keeps only referenced assets', async () => {
    const preview = await previewMarkdownImport(
      pick({
        'docs/a.md':
          '![x](img/one.png) [f](<files/my%20file.pdf?raw=1#top>) <img src="../top.png">',
        'docs/b.md': '![ext](https://example.com/x.png) [link](other.md)',
        'docs/img/one.png': 'x',
        'docs/files/my file.pdf': 'x',
        'docs/img/unused.png': 'x',
        'top.png': 'x',
      }),
    );
    assert.equal(preview.assetCount, 3);
    assert.deepEqual(preview.skipped, ['docs/img/unused.png']);
  });

  test('skips hidden files and folders', async () => {
    const preview = await previewMarkdownImport(
      pick({
        'a.md': '',
        '.git/config': '',
        '.obsidian/n.md': '',
        '__MACOSX/a.md': '',
        'x/.hidden.md': '',
      }),
    );
    assert.deepEqual(titles(preview.tree), [['a', []]]);
    assert.equal(preview.skipped.length, 4);
  });

  test('skips a folder that holds no pages', async () => {
    const preview = await previewMarkdownImport(
      pick({ 'a.md': '![](img/p.png)', 'img/p.png': 'x' }),
    );
    assert.deepEqual(titles(preview.tree), [['a', []]]);
    assert.equal(preview.assetCount, 1);
  });

  test('reports more than 500 pages', async () => {
    const files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`p${i}.md`, '']));
    const { violations } = await previewMarkdownImport(pick(files));
    assert.deepEqual(violations, [{ kind: 'pageCount', count: 501 }]);
  });

  test('reports a page over 250,000 characters, not counting frontmatter', async () => {
    const { violations } = await previewMarkdownImport(
      pick({
        'big.md': 'a'.repeat(250_001),
        'ok.md': `---\ntitle: t\n---\n${'a'.repeat(250_000)}`,
      }),
    );
    assert.deepEqual(violations, [{ kind: 'pageLength', path: 'big.md' }]);
  });

  test('reports a total size over 50 MB', async () => {
    const big = { path: 'big.bin', file: { size: 50 * 1024 * 1024 + 1 } as File };
    const { violations } = await previewMarkdownImport([...pick({ 'a.md': '' }), big]);
    assert.deepEqual(violations, [{ kind: 'zipSize' }]);
  });

  test('names a file that is not valid UTF-8', async () => {
    const { violations, pageCount } = await previewMarkdownImport(
      pick({ 'bad.md': new Uint8Array([0xff, 0xfe, 0x41]), 'ok.md': '' }),
    );
    assert.deepEqual(violations, [{ kind: 'invalidUtf8', path: 'bad.md' }]);
    assert.equal(pageCount, 1);
  });
});

describe('common root', () => {
  test('is dropped when every path shares it', () => {
    const files = pick({ 'notes/a.md': '', 'notes/sub/b.md': '' });
    assert.deepEqual(
      dropCommonRoot(files).map(({ path }) => path),
      ['a.md', 'sub/b.md'],
    );
  });

  test('stays when paths differ at the top', () => {
    const files = pick({ 'a/x.md': '', 'b/y.md': '' });
    assert.equal(dropCommonRoot(files), files);
  });

  test('is read from webkitRelativePath', () => {
    const file = new File([''], 'a.md');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'notes/a.md' });
    assert.deepEqual(
      pickedFolderFiles([file]).map(({ path }) => path),
      ['a.md'],
    );
  });
});

describe('packMarkdownImport', () => {
  test('packs pages and referenced assets, and reads them back', async () => {
    const blob = await packMarkdownImport(
      pick({
        'a.md': '![x](i.png)',
        'sub/b.md': 'b',
        'i.png': 'png',
        'unused.png': 'x',
        '.git/c': 'x',
      }),
    );
    const zipFile = new File([blob], 'import.zip');
    const { files, violations } = await readMarkdownZip(zipFile);
    assert.deepEqual(violations, []);
    assert.deepEqual(files.map(({ path }) => path).sort(), ['a.md', 'i.png', 'sub/b.md']);
    const preview = await previewMarkdownImport(files);
    assert.deepEqual(titles(preview.tree), [
      ['a', []],
      ['sub', [['b', []]]],
    ]);
    assert.equal(preview.assetCount, 1);
  });

  test('rejects a ZIP file over 50 MB', async () => {
    const zip = new JSZip().file('a.md', '');
    const file = new File([await zip.generateAsync({ type: 'blob' })], 'a.zip');
    Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 + 1 });
    assert.deepEqual((await readMarkdownZip(file)).violations, [{ kind: 'zipSize' }]);
  });
});
