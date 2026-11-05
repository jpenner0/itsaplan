import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSlashItems } from './tiptap-slash-command';

describe('buildSlashItems', () => {
  it('exposes the complete Docs block surface without changing compact editors', () => {
    const compact = buildSlashItems({ codeBlockLabel: 'Code' });
    assert.deepEqual(
      compact.map((item) => item.title),
      ['Code'],
    );

    const docs = buildSlashItems({
      codeBlockLabel: 'Code',
      tableLabel: 'Table',
      image: { label: 'Image', onPick: () => undefined },
      blocks: {
        paragraph: 'Text',
        headings: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'],
        bulletList: 'Bullets',
        orderedList: 'Numbers',
        taskList: 'Tasks',
        quote: 'Quote',
        divider: 'Divider',
      },
    });
    assert.deepEqual(
      docs.map((item) => item.title),
      [
        'Text',
        'H1',
        'H2',
        'H3',
        'H4',
        'H5',
        'H6',
        'Bullets',
        'Numbers',
        'Tasks',
        'Quote',
        'Code',
        'Divider',
        'Table',
        'Image',
      ],
    );
  });

  it('offers a task list in a compact editor that registers the extension', () => {
    const items = buildSlashItems({ codeBlockLabel: 'Code', taskListLabel: 'Tasks' });
    assert.deepEqual(
      items.map((item) => item.title),
      ['Tasks', 'Code'],
    );
  });

  it('offers the Mermaid diagram only when it has a label', () => {
    assert.equal(buildSlashItems({ codeBlockLabel: 'Code' }).length, 1);
    const items = buildSlashItems({ codeBlockLabel: 'Code', mermaidLabel: 'Diagram (Mermaid)' });
    assert.deepEqual(
      items.map((item) => item.title),
      ['Code', 'Diagram (Mermaid)'],
    );
    for (const query of ['mermaid', 'diagram']) {
      assert.ok(items.some((item) => item.title.toLowerCase().includes(query)));
    }
  });

  it('inserts a mermaid code block with example content', () => {
    const item = buildSlashItems({ codeBlockLabel: 'Code', mermaidLabel: 'Diagram (Mermaid)' })[1];
    const calls: unknown[] = [];
    const chain = {
      focus: () => chain,
      deleteRange: () => chain,
      insertContent: (content: unknown) => {
        calls.push(content);
        return chain;
      },
      run: () => true,
    };
    item?.run({ editor: { chain: () => chain } as never, range: { from: 0, to: 1 } });
    assert.deepEqual(calls, [
      {
        type: 'codeBlock',
        attrs: { language: 'mermaid' },
        content: [{ type: 'text', text: 'flowchart TD\n    A --> B' }],
      },
    ]);
  });
});
