import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import type { GitManagedRepository } from '@/lib/api/endpoints/git';
import issue from '../../../../../messages/en/issue.json';
import settings from '../../../../../messages/en/settings.json';

const replacedGlobals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLFormElement',
  'Event',
  'MouseEvent',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const repository: GitManagedRepository = {
  id: 7,
  externalId: '1',
  fullName: 'acme/site',
  webUrl: 'https://github.com/acme/site',
  status: 'connected',
  lastError: null,
  issuesSyncEnabled: false,
  newIssuesToProvider: true,
};

let requests: { url: string; method: string; body: string | null }[];
let dom: JSDOM;
let root: Root;
let client: QueryClient;
let originalGlobalDescriptors: Map<string, PropertyDescriptor | undefined>;

beforeEach(async () => {
  requests = [];
  originalGlobalDescriptors = new Map(
    replacedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  for (const name of replacedGlobals) {
    if (name in dom.window) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: dom.window[name as keyof typeof dom.window],
      });
    }
  }
  Object.defineProperties(globalThis, {
    fetch: {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: (init?.body as string | undefined) ?? null,
        });
        return Response.json({});
      },
    },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(window, '__ITSAPLAN_ENV__', {
    value: { apiUrl: 'https://api.test', privacyUrl: '', termsUrl: '' },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root')!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  dom.window.close();
  for (const [name, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function render(repo: GitManagedRepository) {
  const { default: GitRepositoryIssueSync } = await import('./GitRepositoryIssueSync');
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={{ issue, settings }} timeZone="UTC">
          <GitRepositoryIssueSync projectKey="acme.TEST" connectionId={3} repository={repo} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

describe('GitRepositoryIssueSync', () => {
  it('warns about the one-time import while sync is off and hides the second toggle', async () => {
    await render(repository);

    assert.equal(document.querySelectorAll('[role="switch"]').length, 1);
    assert.ok(document.body.textContent!.includes('imports all open GitHub issues once'));
    assert.ok(!document.body.textContent!.includes('New issues to GitHub'));
  });

  it('turns sync on through the issue-sync route', async () => {
    await render(repository);

    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="switch"]')!
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    assert.deepEqual(requests[0], {
      url: 'https://api.test/projects/acme.TEST/settings/git/connections/3/repositories/7/issue-sync',
      method: 'PATCH',
      body: JSON.stringify({ issuesSyncEnabled: true }),
    });
  });

  it('says that turning sync off keeps the issues and shows the new-issues toggle', async () => {
    await render({ ...repository, issuesSyncEnabled: true });

    assert.equal(document.querySelectorAll('[role="switch"]').length, 2);
    assert.ok(document.body.textContent!.includes('only removes the links'));
    assert.ok(document.body.textContent!.includes('New issues to GitHub'));
  });
});
