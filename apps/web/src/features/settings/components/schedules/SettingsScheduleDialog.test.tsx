import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import type { AgentSchedule, AgentScheduleInput } from '@/lib/api/endpoints/agentSchedules';
import type { ProjectAgent } from '@/lib/api/endpoints/agents';
import common from '../../../../../messages/en/common.json';
import teams from '../../../../../messages/en/teams.json';
import settings from '../../../../../messages/en/settings.json';

const replacedGlobals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLFormElement',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'MutationObserver',
  'getComputedStyle',
  'Node',
  'DocumentFragment',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const agent = { id: 5, name: 'Triager', kind: 'internal' } as ProjectAgent;

function schedule(type: string): AgentSchedule {
  return {
    id: 1,
    agentId: 5,
    agentName: 'Triager',
    name: 'Triage',
    type,
    prompt: 'Label it',
    cron: null,
    timezone: 'UTC',
    columnId: null,
    delaySec: 0,
    options: {},
    status: 'active',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    pendingRuns: 0,
    canTrigger: true,
    supported: true,
    createdAt: '',
    updatedAt: '',
  };
}

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

async function renderDialog(
  initial: AgentSchedule,
  onSave: (v: AgentScheduleInput) => Promise<void>,
) {
  const { SettingsScheduleDialog } = await import('./SettingsScheduleDialog');
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={{ common, settings, teams }} timeZone="UTC">
          <SettingsScheduleDialog
            projectKey="acme.TEST"
            agents={[agent]}
            columns={[]}
            initial={initial}
            saving={false}
            onSave={onSave}
            onClose={() => {}}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

async function renderTypeField(value: string) {
  const { SettingsScheduleTypeField } = await import('./SettingsScheduleTypeField');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ settings }} timeZone="UTC">
        <SettingsScheduleTypeField value={value} onChange={() => {}} />
      </NextIntlClientProvider>,
    );
  });
}

describe('SettingsScheduleTypeField', () => {
  it('explains the triage trigger', async () => {
    await renderTypeField('synced_issue_created');
    assert.ok(document.body.textContent!.includes('Not for the first import'));
  });

  it('explains the review trigger', async () => {
    await renderTypeField('pull_request_opened');
    assert.ok(document.body.textContent!.includes('Not on every push'));
  });

  it('shows no hint for a cron schedule', async () => {
    await renderTypeField('cron');
    assert.ok(!document.body.textContent!.includes('Not on every push'));
  });
});

describe('SettingsScheduleDialog', () => {
  for (const type of ['synced_issue_created', 'pull_request_opened']) {
    it(`saves a ${type} schedule without cron or state fields`, async () => {
      const saved: AgentScheduleInput[] = [];
      await renderDialog(schedule(type), async (value) => void saved.push(value));

      assert.equal(document.getElementById('schedule-input'), null);
      assert.ok(!document.body.textContent!.includes('Wait before starting'));

      await act(async () => {
        document
          .querySelector('form')!
          .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });

      assert.deepEqual(saved, [
        { agentId: 5, name: 'Triage', prompt: 'Label it', status: 'active' },
      ]);
    });
  }
});
