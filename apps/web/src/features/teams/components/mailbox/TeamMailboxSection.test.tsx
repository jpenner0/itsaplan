import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import type { Team, TeamRole } from '@/lib/api/endpoints/teams';
import type { TeamMailbox } from '@/lib/api/endpoints/teamMailbox';
import teams from '../../../../../messages/en/teams.json';
import common from '../../../../../messages/en/common.json';

const replacedGlobals = [
  'window',
  'document',
  'navigator',
  'Node',
  'NodeFilter',
  'DocumentFragment',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLFormElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'SVGElement',
  'ShadowRoot',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
  'fetch',
] as const;

const mailbox: TeamMailbox = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: 'password',
  username: 'intake@example.com',
  tenantId: null,
  clientId: null,
  hasSecret: true,
  agentId: 4,
  agentName: 'Triage',
  allowedSenders: ['@example.com'],
  status: 'paused',
  lastError: 'Login failed',
  lastPolledAt: null,
};

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let originals: Map<string, PropertyDescriptor | undefined>;
let requested: string[];

const team = (role: TeamRole) => ({ id: 1, role, name: 'Acme' }) as Team;

async function render(role: TeamRole) {
  const body = (url: string) =>
    url.endsWith('/mailbox') ? mailbox : url.endsWith('/ai-agents') ? [] : [team(role)];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: Request | string | URL) => {
      const url = new URL(typeof input === 'string' ? input : String(input)).pathname;
      requested.push(url);
      return Response.json(body(url));
    },
  });
  const { default: TeamMailboxSection } = await import('./TeamMailboxSection');
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={{ teams, common }} timeZone="UTC">
          <TeamMailboxSection teamId={1} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(async () => {
  originals = new Map(
    replacedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.assign(dom.window, {
    __ITSAPLAN_ENV__: { apiUrl: 'http://api.test', privacyUrl: '', termsUrl: '' },
  });
  for (const name of replacedGlobals) {
    if (name !== 'fetch' && name in dom.window) {
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
  requested = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.querySelector('#root')!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('TeamMailboxSection', () => {
  it('shows a plain member a notice and requests no mailbox', async () => {
    await render('member');

    assert.ok(document.body.textContent?.includes(teams.mailbox.managerOnly));
    assert.equal(document.querySelector('form'), null);
    assert.ok(!requested.some((url) => url.endsWith('/mailbox')));
  });

  it('shows a manager the form with the status and an empty secret field', async () => {
    await render('manager');

    assert.ok(requested.some((url) => url.endsWith('/mailbox')));
    const password = document.querySelector<HTMLInputElement>('#mailbox-password')!;
    assert.equal(password.value, '');
    assert.equal(password.type, 'password');
    assert.equal(document.querySelector<HTMLInputElement>('#mailbox-host')!.value, mailbox.host);
    assert.ok(document.body.textContent?.includes('Login failed'));
    assert.ok(document.body.textContent?.includes(teams.mailbox.allowedSendersHint));
  });
});
