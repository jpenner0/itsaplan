import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import issue from '../../../../../messages/en/issue.json';

const replaced = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'MutationObserver',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
];

let dom: JSDOM;
let root: Root;
let descriptors: Map<string, PropertyDescriptor | undefined>;

const addButton = () =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add');

async function render(props: { syncsIssues: boolean; canManage: boolean }) {
  const { default: IssueDevelopmentPanel } = await import('./IssueDevelopmentPanel');
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{ issue }} timeZone="UTC">
          <IssueDevelopmentPanel
            issueId={1}
            identifier="MKT-1"
            issueTitle="Task"
            links={[]}
            canEdit
            {...props}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(async () => {
  descriptors = new Map(
    replaced.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  for (const name of replaced) {
    if (name in dom.window) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: dom.window[name as keyof typeof dom.window],
      });
    }
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  Object.defineProperties(globalThis, {
    requestAnimationFrame: {
      configurable: true,
      value: dom.window.requestAnimationFrame.bind(dom.window),
    },
    cancelAnimationFrame: {
      configurable: true,
      value: dom.window.cancelAnimationFrame.bind(dom.window),
    },
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  window.__ITSAPLAN_ENV__ = { apiUrl: 'http://api.test', privacyUrl: '', termsUrl: '' };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root')!);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

// A member with the work item permission only: the panel is offered by the issue's own
// `syncsIssues`, not by a request the member cannot make.
it('offers the add menu to an editor when the project syncs issues', async () => {
  await render({ syncsIssues: true, canManage: false });
  assert.ok(addButton());
});

it('shows nothing to an editor when the project does not sync issues', async () => {
  await render({ syncsIssues: false, canManage: false });
  assert.equal(addButton(), undefined);
});
