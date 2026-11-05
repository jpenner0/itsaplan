import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { toast } from 'sonner';
import documentMessages from '../../../../messages/en/documents.json';
import type { PickedFile } from '../utils/markdownFolderImport';

type UseMarkdownImport = (typeof import('./useMarkdownImport'))['useMarkdownImport'];
type Controller = ReturnType<UseMarkdownImport>;

const replacedGlobals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

let dom: JSDOM;
let root: Root;
let queryClient: QueryClient;
let useMarkdownImport: UseMarkdownImport;
let originalFetch: typeof fetch;
let originalSuccess: typeof toast.success;
let controller: Controller | null;
let imported: number;
let successes: string[];
let requests: { url: string; body: FormData }[];
let originalGlobalDescriptors: Map<string, PropertyDescriptor | undefined>;

const page = (path: string, text: string): PickedFile => ({
  path,
  file: new File([text], path.split('/').pop()!),
});

function Probe() {
  controller = useMarkdownImport({
    projectKey: 'SEKTA',
    parentId: 5,
    onImported: () => {
      imported += 1;
    },
  });
  return null;
}

// Only the HTTP call is replaced.
function stubImport(response: Response) {
  globalThis.fetch = ((url: string, init: RequestInit) => {
    requests.push({ url, body: init.body as FormData });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  originalGlobalDescriptors = new Map(
    replacedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://plan.example.test' });
  dom.window.__ITSAPLAN_ENV__ = {
    apiUrl: 'https://api.example.test',
    privacyUrl: '',
    termsUrl: '',
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  ({ useMarkdownImport } = await import('./useMarkdownImport'));
  originalFetch = globalThis.fetch;
  originalSuccess = toast.success;
  successes = [];
  toast.success = ((message: string) => {
    successes.push(message);
    return 1;
  }) as typeof toast.success;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  controller = null;
  imported = 0;
  requests = [];

  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.querySelector('#root')!);
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ documents: documentMessages }}>
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  toast.success = originalSuccess;
  act(() => root.unmount());
  queryClient.clear();
  dom.window.close();
  for (const [name, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('useMarkdownImport', () => {
  it('shows the preview of the chosen files and allows the import', async () => {
    await act(() =>
      controller!.choose([page('guide/index.md', '# Guide'), page('guide/a.md', 'A')]),
    );

    assert.equal(controller!.preview?.pageCount, 2);
    assert.equal(controller!.canImport, true);
  });

  it('blocks the import while the preview has violations', async () => {
    const bad = { path: 'bad.md', file: new File([new Uint8Array([0xff, 0xfe])], 'bad.md') };
    await act(() => controller!.choose([bad]));

    assert.deepEqual(controller!.preview?.violations, [{ kind: 'invalidUtf8', path: 'bad.md' }]);
    assert.equal(controller!.canImport, false);
  });

  it('blocks the import when there is nothing to import', async () => {
    await act(() => controller!.choose([page('notes.txt', 'text')]));

    assert.equal(controller!.preview?.pageCount, 0);
    assert.equal(controller!.canImport, false);
  });

  it('uploads the ZIP with the parent, toasts the created count and closes', async () => {
    stubImport(
      new Response(JSON.stringify({ documents: [], createdCount: 3, skipped: [] }), {
        status: 201,
      }),
    );
    await act(() => controller!.choose([page('a.md', 'A')]));
    await act(() => controller!.submit());

    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith('/projects/SEKTA/documents/import'));
    assert.equal(requests[0].body.get('parentId'), '5');
    assert.ok(requests[0].body.get('file') instanceof File);
    assert.deepEqual(successes, ['Imported pages: 3']);
    assert.equal(imported, 1);
  });

  it('shows the message of the api error and keeps the dialog open', async () => {
    stubImport(
      new Response(JSON.stringify({ error: 'docs/bad.md is not valid UTF-8' }), { status: 400 }),
    );
    await act(() => controller!.choose([page('a.md', 'A')]));
    await act(() => controller!.submit());

    assert.equal(controller!.error, 'docs/bad.md is not valid UTF-8');
    assert.equal(controller!.canImport, true);
    assert.equal(imported, 0);
    assert.deepEqual(successes, []);
  });

  it('uploads once when Import is clicked twice', async () => {
    stubImport(
      new Response(JSON.stringify({ documents: [], createdCount: 1, skipped: [] }), {
        status: 201,
      }),
    );
    await act(() => controller!.choose([page('a.md', 'A')]));
    await act(() => Promise.all([controller!.submit(), controller!.submit()]));

    assert.equal(requests.length, 1);
    assert.equal(imported, 1);
  });

  it('drops the result of a read that was reset', async () => {
    await act(async () => {
      const reading = controller!.choose([page('a.md', 'A')]);
      controller!.reset();
      await reading;
    });

    assert.equal(controller!.preview, null);
    assert.equal(controller!.reading, false);
  });
});
