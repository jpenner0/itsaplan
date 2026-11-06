import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
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

async function openMenu(props: {
  onLink?: () => void;
  onCreate?: () => void;
  onPublish?: () => void;
}) {
  const { default: IssueDevelopmentAddMenu } = await import('./IssueDevelopmentAddMenu');
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={{ issue }} timeZone="UTC">
        <IssueDevelopmentAddMenu {...props} />
      </NextIntlClientProvider>,
    ),
  );
  const trigger = document.querySelector<HTMLElement>('button')!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
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

it('offers only publish without the repository permission', async () => {
  assert.deepEqual(await openMenu({ onPublish: () => {} }), ['Publish to GitHub']);
});

it('offers link and create with the repository permission', async () => {
  assert.deepEqual(await openMenu({ onLink: () => {}, onCreate: () => {} }), [
    'Link existing',
    'Create pull request',
  ]);
});
