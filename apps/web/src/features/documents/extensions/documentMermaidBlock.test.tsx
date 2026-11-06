import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, EditorContent } from '@tiptap/react';
import { NextIntlClientProvider } from 'next-intl';
import * as themes from 'next-themes';
import { JSDOM } from 'jsdom';
import * as mermaid from '@/lib/mermaid';
import documents from '../../../../messages/en/documents.json';
import { buildSlashItems } from '@/lib/tiptap-slash-command';
import { documentEditorExtensions } from '../components/DocumentMarkdownEditor';

const spyOn = createRequire(import.meta.url)('bun:test').spyOn as (
  target: object,
  method: string,
) => {
  mockImplementation(fn: (...args: never[]) => unknown): { mockRestore(): void };
};

const markdown = [
  'Intro',
  '',
  '```mermaid',
  'flowchart TD',
  '  A --> B',
  '```',
  '',
  '```ts',
  'const a = 1;',
  '```',
].join('\n');

let dom: JSDOM;
let root: Root;
let editor: Editor;
let originals: Map<string, PropertyDescriptor | undefined>;
let restoreSpies: () => void;
let rendered: string[];

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

function createEditor(content: string) {
  editor = new Editor({
    element: document.getElementById('editor')!,
    extensions: documentEditorExtensions({ placeholder: '', codeBlockLabel: '', tableLabel: '' }),
    content,
    editorProps: { handleScrollToSelection: () => true },
  });
}

async function render() {
  await act(() =>
    root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ documents }}>
        <EditorContent editor={editor} />
      </NextIntlClientProvider>,
    ),
  );
  await settle();
}

function button(label: string) {
  return [...editor.view.dom.querySelectorAll('button')].find(
    (element) => element.textContent === label,
  );
}

async function click(label: string) {
  const element = button(label);
  assert.ok(element, label);
  await act(() => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
}

const mermaidBlock = () => editor.view.dom.querySelector('[data-node-view-wrapper]');
const sourceVisible = () => !mermaidBlock()!.querySelector('pre')!.classList.contains('hidden');

beforeEach(() => {
  dom = new JSDOM('<div id="root"></div><div id="editor"></div>', {
    url: 'https://planner.test',
    pretendToBeVisual: true,
  });
  dom.window.matchMedia = (media) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    Node: dom.window.Node,
    DOMRect: dom.window.DOMRect,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  rendered = [];
  const spy = spyOn(mermaid, 'renderMermaid').mockImplementation(async (source: string) => {
    rendered.push(source);
    return { svg: '<svg data-diagram=""></svg>' };
  });
  // next-themes reads `window` once at import, before the test sets up the DOM.
  const theme = spyOn(themes, 'useTheme').mockImplementation(() => ({ resolvedTheme: 'light' }));
  restoreSpies = () => {
    spy.mockRestore();
    theme.mockRestore();
  };
  root = createRoot(document.getElementById('root')!);
});

afterEach(async () => {
  await act(() => root.unmount());
  editor.destroy();
  restoreSpies();
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('documentMermaidBlock', () => {
  it('keeps the Markdown of a mermaid block byte-identical', async () => {
    createEditor(markdown);
    await render();
    assert.equal(editor.storage.markdown.getMarkdown(), markdown);
  });

  it('renders a plain code block without the Mermaid view', async () => {
    createEditor('```ts\nconst a = 1;\n```');
    await render();
    assert.equal(mermaidBlock(), null);
    assert.ok(editor.view.dom.querySelector('pre > code.language-ts'));
    assert.deepEqual(rendered, []);
  });

  it('switches between the diagram and the code with Edit code and Done', async () => {
    createEditor(markdown);
    await render();
    assert.ok(mermaidBlock()!.querySelector('svg[data-diagram]'));
    assert.equal(sourceVisible(), false);

    await click('Edit code');
    assert.equal(sourceVisible(), true);
    assert.ok(mermaidBlock()!.querySelector('svg[data-diagram]'));
    assert.ok(button('Done'));

    await click('Done');
    assert.equal(sourceVisible(), false);
    assert.ok(button('Edit code'));
  });

  it('offers only Copy code when the editor is read-only', async () => {
    createEditor(markdown);
    await render();
    await click('Edit code');
    await act(() => editor.setEditable(false, false));
    await settle();
    assert.equal(sourceVisible(), false);
    assert.equal(button('Edit code'), undefined);
    assert.equal(button('Done'), undefined);
    assert.ok(button('Copy code'));
  });

  it('turns a code block into a diagram when its language becomes mermaid', async () => {
    createEditor('```ts\nflowchart TD\n```');
    await render();
    assert.equal(mermaidBlock(), null);
    await act(() => editor.commands.updateAttributes('codeBlock', { language: 'mermaid' }));
    await settle();
    assert.ok(mermaidBlock());
    await act(() => editor.commands.updateAttributes('codeBlock', { language: 'ts' }));
    await settle();
    assert.equal(mermaidBlock(), null);
    assert.ok(editor.view.dom.querySelector('pre > code.language-ts'));
  });

  it('shows the diagram that the slash item inserts into an empty paragraph', async () => {
    createEditor('');
    await render();
    editor.commands.insertContent('/diagram');
    const item = buildSlashItems({ codeBlockLabel: 'Code', mermaidLabel: 'Diagram (Mermaid)' })[1]!;
    await act(async () => item.run({ editor, range: { from: 1, to: 9 } }));
    await settle();
    assert.equal(
      editor.storage.markdown.getMarkdown().trim(),
      '```mermaid\nflowchart TD\n    A --> B\n```',
    );
    assert.ok(mermaidBlock());
    assert.deepEqual(rendered, ['flowchart TD\n    A --> B']);
  });
});
