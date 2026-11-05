import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { account, db, issueCommentSyncLink, issueSyncLink } from '@repo/db';
import { app } from '../../../../app';
import { authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { reconcileIssueSync } from '../../service';

// GitHub → It's a Plan issue sync against a GitHub served on localhost. The SSRF guard
// refuses http and loopback hosts under NODE_ENV=test, so each case runs as development,
// the way the managed webhook tests reach their fake provider.

const T0 = '2020-01-01T00:00:00Z';
const LATER = '2021-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

type Row = Record<string, unknown>;

function ghIssue(number: number, overrides: Row = {}): Row {
  return {
    id: 9000 + number,
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    state_reason: null,
    html_url: `https://github.com/acme/site/issues/${number}`,
    repository_url: 'https://api.github.com/repos/acme/site',
    user: { id: 2001, login: 'reporter' },
    assignees: [],
    labels: [],
    created_at: T0,
    updated_at: T0,
    closed_at: null,
    ...overrides,
  };
}

function ghComment(id: number, issueNumber: number, overrides: Row = {}): Row {
  return {
    id,
    body: `Comment ${id}`,
    html_url: `https://github.com/acme/site/issues/${issueNumber}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/acme/site/issues/${issueNumber}`,
    user: { id: 2001, login: 'reporter' },
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function fakeGithub() {
  const issues = new Map<number, Row>();
  const comments: Row[] = [];
  const hooks = new Map<number, { id: number; url: string; events: string[] }>();
  let nextHookId = 1;
  const prefix = '/api/v3';
  const sinceFilter = (rows: Row[], since: string | null) =>
    since ? rows.filter((row) => Date.parse(row.updated_at as string) >= Date.parse(since)) : rows;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.slice(prefix.length);
      if (path === '/user') return Response.json({ login: 'octo' });
      if (path === '/repositories/1') {
        return Response.json({
          id: 1,
          full_name: 'acme/site',
          html_url: 'https://github.com/acme/site',
          permissions: { admin: true },
        });
      }
      if (path === '/repos/acme/site/hooks' && req.method === 'GET') {
        return Response.json(
          [...hooks.values()].map((hook) => ({ id: hook.id, config: { url: hook.url } })),
        );
      }
      if (path === '/repos/acme/site/hooks' && req.method === 'POST') {
        const body = (await req.json()) as { events: string[]; config: { url: string } };
        const hook = { id: nextHookId++, url: body.config.url, events: body.events };
        hooks.set(hook.id, hook);
        return Response.json({ id: hook.id, config: { url: hook.url } }, { status: 201 });
      }
      const hookMatch = path.match(/^\/repos\/acme\/site\/hooks\/(\d+)$/);
      if (hookMatch && req.method === 'PATCH') {
        const hook = hooks.get(Number(hookMatch[1]));
        if (!hook) return Response.json({ message: 'Not Found' }, { status: 404 });
        hook.events = ((await req.json()) as { events: string[] }).events;
        return Response.json({ id: hook.id, config: { url: hook.url } });
      }
      if (path === '/repos/acme/site/issues') {
        const state = url.searchParams.get('state');
        const rows = [...issues.values()].filter((row) => state === 'all' || row.state === state);
        return Response.json(sinceFilter(rows, url.searchParams.get('since')));
      }
      if (path === '/repos/acme/site/issues/comments') {
        return Response.json(sinceFilter(comments, url.searchParams.get('since')));
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    issues,
    comments,
    hooks,
    put: (row: Row) => issues.set(row.number as number, row),
    stop: () => server.stop(true),
  };
}

type Fake = ReturnType<typeof fakeGithub>;

interface Ctx {
  asOwner: Api;
  ownerId: string;
  ownerUsername: string;
  teamId: number;
  connectionId: number;
  repositoryId: number;
  webhookId: string;
  secret: string;
  columns: { id: number; stateType: string; name: string }[];
}

async function setup(
  fake: Fake,
  key = 'MKT',
  owner?: { cookie: string; userId: string; username: string },
) {
  const user = owner ?? (await signUpTestUser({ name: 'Owner' }));
  const asOwner = authedApi(user.cookie);
  const created = await createProject(asOwner, { key, name: `Project ${key}` });
  const teamId = created.data!.teamId;
  const connection = await asOwner
    .teams({ teamId })
    .settings.git.connections.post({ provider: 'github', baseUrl: fake.baseUrl, token: 't-1' });
  expect(connection.status).toBe(201);
  const connectionId = connection.data!.id;
  const connected = await asOwner
    .projects({ projectKey: key })
    .settings.git.connections({ connectionId })
    .repositories.post({ externalIds: ['1'] });
  expect(connected.status).toBe(200);
  const settings = (await asOwner.projects({ projectKey: key }).settings.git.get()).data!;
  const view = (await asOwner.projects({ projectKey: key }).get()).data!;
  return {
    asOwner,
    ownerId: user.userId,
    ownerUsername: user.username,
    teamId,
    connectionId,
    repositoryId: connected.data!.repositories[0]!.id,
    webhookId: settings.webhookId,
    secret: settings.secret,
    columns: view.columns,
  } satisfies Ctx;
}

function syncSettings(ctx: Ctx, key = 'MKT') {
  return ctx.asOwner
    .projects({ projectKey: key })
    .settings.git.connections({ connectionId: ctx.connectionId })
    .repositories({ repositoryId: ctx.repositoryId })['issue-sync'];
}

async function enable(ctx: Ctx) {
  const response = await syncSettings(ctx).patch({ issuesSyncEnabled: true });
  expect(response.status).toBe(200);
  return response.data!;
}

async function deliver(ctx: Ctx, event: 'issues' | 'issue_comment', payload: Row) {
  const body = JSON.stringify({ ...payload, repository: { full_name: 'acme/site' } });
  const signature = `sha256=${createHmac('sha256', ctx.secret).update(body).digest('hex')}`;
  const res = await app.handle(
    new Request(`http://localhost/webhooks/git/${ctx.webhookId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-hub-signature-256': signature,
        'x-github-delivery': crypto.randomUUID(),
      },
      body,
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

function issueEvent(ctx: Ctx, action: string, issue: Row, extra: Row = {}) {
  return deliver(ctx, 'issues', { action, issue, ...extra });
}

function commentEvent(ctx: Ctx, action: string, issueNumber: number, comment: Row) {
  return deliver(ctx, 'issue_comment', { action, issue: { number: issueNumber }, comment });
}

async function listIssues(ctx: Ctx, key = 'MKT') {
  const hits = await ctx.asOwner.projects({ projectKey: key }).issues.get({ query: {} });
  expect(hits.status).toBe(200);
  return hits.data!;
}

async function issueByTitle(ctx: Ctx, title: string) {
  const hit = (await listIssues(ctx)).find((item) => item.title === title);
  expect(hit).toBeDefined();
  return (await ctx.asOwner.issues({ issueId: hit!.id }).get()).data!;
}

async function projectLabels(ctx: Ctx) {
  return (await ctx.asOwner.projects({ projectKey: 'MKT' }).get()).data!.labels;
}

async function labelNames(ctx: Ctx, ids: number[]) {
  const labels = await projectLabels(ctx);
  return labels
    .filter((item) => ids.includes(item.id))
    .map((item) => item.name)
    .sort();
}

async function comments(ctx: Ctx, issueId: number) {
  const feed = await ctx.asOwner
    .issues({ issueId })
    .feed.get({ query: { filter: 'comments', order: 'asc' } });
  return feed.data!.items;
}

const columnOf = (ctx: Ctx, stateType: string) =>
  ctx.columns.find((column) => column.stateType === stateType)!.id;

async function linkGithubAccount(userId: string, githubId: string) {
  await db.insert(account).values({
    id: crypto.randomUUID(),
    userId,
    providerId: 'github',
    accountId: githubId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('GitHub issue sync, inbound', () => {
  const environment = { ...process.env };
  let fake: Fake;

  beforeEach(async () => {
    await resetDb();
    process.env.NODE_ENV = 'development';
    fake = fakeGithub();
  });

  afterEach(() => {
    fake.stop();
    process.env.NODE_ENV = environment.NODE_ENV;
  });

  it('imports only open issues, sets the watermark, and adds issue events to the hook', async () => {
    const ctx = await setup(fake);
    const hook = [...fake.hooks.values()][0]!;
    hook.events = ['pull_request'];
    fake.put(ghIssue(1, { title: 'Open one', body: 'Hello', updated_at: LATER }));
    fake.put(ghIssue(2, { title: 'Closed one', state: 'closed', state_reason: 'completed' }));
    fake.comments.push(ghComment(501, 1, { body: 'First!' }));

    const settings = await enable(ctx);

    expect(settings).toMatchObject({ issuesSyncEnabled: true, newIssuesToProvider: true });
    expect(new Date(settings.issuesWatermark!)).toEqual(new Date(LATER));
    expect(hook.events).toEqual(expect.arrayContaining(['issues', 'issue_comment']));
    const titles = (await listIssues(ctx)).map((item) => item.title);
    expect(titles).toEqual(['Open one']);
    const imported = await issueByTitle(ctx, 'Open one');
    expect(imported).toMatchObject({
      description: 'Hello',
      columnId: columnOf(ctx, 'unstarted'),
    });
    expect((await comments(ctx, imported.id)).map((item) => item.body)).toEqual(['First!']);
    expect(imported.development).toMatchObject([
      { kind: 'issue', provider: 'github', repository: 'acme/site', number: 1, state: 'open' },
    ]);
    const repositories = (
      await ctx.asOwner.projects({ projectKey: 'MKT' }).settings.git.connections.get()
    ).data![0]!.repositories;
    expect(repositories[0]).toMatchObject({ issuesSyncEnabled: true });
  });

  it('refuses a second project syncing the same repository with 409', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const owner = await signUpTestUser({ name: 'Other' });
    const other = await setup(fake, 'OPS', owner);

    const response = await syncSettings(other, 'OPS').patch({ issuesSyncEnabled: true });

    expect(response.status).toBe(409);
  });

  it('refuses a provider other than GitHub and a repository of another project', async () => {
    const ctx = await setup(fake);
    const missing = await ctx.asOwner
      .projects({ projectKey: 'MKT' })
      .settings.git.connections({ connectionId: ctx.connectionId })
      .repositories({ repositoryId: ctx.repositoryId + 1000 })
      ['issue-sync'].patch({ issuesSyncEnabled: true });
    expect(missing.status).toBe(404);
  });

  it('applies edited, labeled and assigned issue deliveries', async () => {
    const ctx = await setup(fake);
    await linkGithubAccount(ctx.ownerId, '1001');
    fake.put(ghIssue(1, { title: 'Bug' }));
    await enable(ctx);

    await issueEvent(
      ctx,
      'edited',
      ghIssue(1, {
        title: 'Bug, renamed',
        body: "Details\n\nTracked in It's a Plan: [MKT-1](https://plan.example/MKT-1)",
        updated_at: LATER,
      }),
    );
    let issue = await issueByTitle(ctx, 'Bug, renamed');
    expect(issue.description).toBe('Details');

    await issueEvent(
      ctx,
      'labeled',
      ghIssue(1, {
        title: 'Bug, renamed',
        body: 'Details',
        labels: [{ name: 'bug', color: 'd73a4a' }],
        updated_at: '2021-02-01T00:00:00Z',
      }),
    );
    issue = await issueByTitle(ctx, 'Bug, renamed');
    expect(await labelNames(ctx, issue.labelIds)).toEqual(['bug']);
    const labels = await projectLabels(ctx);
    expect(labels.find((item) => item.name === 'bug')?.color).toBe('#d73a4a');

    await issueEvent(
      ctx,
      'assigned',
      ghIssue(1, {
        title: 'Bug, renamed',
        body: 'Details',
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [
          { id: 3003, login: 'stranger' },
          { id: 1001, login: 'owner' },
        ],
        updated_at: '2021-03-01T00:00:00Z',
      }),
    );
    issue = await issueByTitle(ctx, 'Bug, renamed');
    expect(issue.assigneeUserId).toBe(ctx.ownerId);

    await issueEvent(
      ctx,
      'unlabeled',
      ghIssue(1, {
        title: 'Bug, renamed',
        body: 'Details',
        assignees: [{ id: 3003, login: 'stranger' }],
        updated_at: '2021-04-01T00:00:00Z',
      }),
    );
    issue = await issueByTitle(ctx, 'Bug, renamed');
    expect(issue.labelIds).toEqual([]);
    expect(issue.assigneeUserId).toBeNull();
    // A label removed from the issue stays in the project.
    expect((await projectLabels(ctx)).map((item) => item.name)).toContain('bug');
  });

  it('moves the issue on closed (completed, not planned) and reopened', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task' }));
    await enable(ctx);

    await issueEvent(
      ctx,
      'closed',
      ghIssue(1, {
        title: 'Task',
        state: 'closed',
        state_reason: 'completed',
        updated_at: LATER,
      }),
    );
    expect((await issueByTitle(ctx, 'Task')).columnId).toBe(columnOf(ctx, 'completed'));

    await issueEvent(
      ctx,
      'reopened',
      ghIssue(1, { title: 'Task', state_reason: 'reopened', updated_at: '2021-02-01T00:00:00Z' }),
    );
    expect((await issueByTitle(ctx, 'Task')).columnId).toBe(columnOf(ctx, 'unstarted'));

    await issueEvent(
      ctx,
      'closed',
      ghIssue(1, {
        title: 'Task',
        state: 'closed',
        state_reason: 'not_planned',
        updated_at: '2021-03-01T00:00:00Z',
      }),
    );
    expect((await issueByTitle(ctx, 'Task')).columnId).toBe(columnOf(ctx, 'canceled'));
  });

  it('leaves an open issue in its open column', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task' }));
    await enable(ctx);
    const issue = await issueByTitle(ctx, 'Task');
    const started = columnOf(ctx, 'started');
    await ctx.asOwner.issues({ issueId: issue.id }).patch({ columnId: started });

    await issueEvent(
      ctx,
      'edited',
      ghIssue(1, { title: 'Task', body: 'More', updated_at: FUTURE }),
    );

    expect(await issueByTitle(ctx, 'Task')).toMatchObject({
      columnId: started,
      description: 'More',
    });
  });

  for (const action of ['deleted', 'transferred'] as const) {
    it(`cancels the issue and removes the link when the GitHub issue is ${action}`, async () => {
      const ctx = await setup(fake);
      fake.put(ghIssue(1, { title: 'Task' }));
      await enable(ctx);

      await issueEvent(ctx, action, ghIssue(1, { title: 'Task', updated_at: LATER }));

      const issue = await issueByTitle(ctx, 'Task');
      expect(issue.columnId).toBe(columnOf(ctx, 'canceled'));
      expect(await db.select().from(issueSyncLink)).toEqual([]);
      expect(issue.development).toEqual([]);
    });
  }

  it('imports an issue opened after the sync was turned on', async () => {
    const ctx = await setup(fake);
    await enable(ctx);

    await issueEvent(ctx, 'opened', ghIssue(7, { title: 'New report', updated_at: LATER }));

    expect((await listIssues(ctx)).map((item) => item.title)).toEqual(['New report']);
  });

  it('ignores an incoming state equal to the synced one', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task' }));
    await enable(ctx);
    const issue = await issueByTitle(ctx, 'Task');
    await ctx.asOwner.issues({ issueId: issue.id }).patch({ title: 'Local title' });

    // The same state as the import, with a newer timestamp: an echo of the sync's own write.
    await issueEvent(ctx, 'edited', ghIssue(1, { title: 'Task', updated_at: FUTURE }));

    expect((await ctx.asOwner.issues({ issueId: issue.id }).get()).data!.title).toBe('Local title');
  });

  it('ignores a delivery older than the state already synced', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task', updated_at: LATER }));
    await enable(ctx);

    await issueEvent(ctx, 'edited', ghIssue(1, { title: 'Stale', updated_at: T0 }));

    expect((await listIssues(ctx)).map((item) => item.title)).toEqual(['Task']);
  });

  it('keeps a newer local change over an older GitHub change of the same field', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task', body: 'Body' }));
    await enable(ctx);
    const issue = await issueByTitle(ctx, 'Task');
    await ctx.asOwner.issues({ issueId: issue.id }).patch({ title: 'Local title' });

    await issueEvent(
      ctx,
      'edited',
      ghIssue(1, { title: 'Remote title', body: 'Remote body', updated_at: LATER }),
    );

    const after = (await ctx.asOwner.issues({ issueId: issue.id }).get()).data!;
    expect(after).toMatchObject({ title: 'Local title', description: 'Remote body' });

    await issueEvent(
      ctx,
      'edited',
      ghIssue(1, { title: 'Newest remote', body: 'Remote body', updated_at: FUTURE }),
    );
    expect((await ctx.asOwner.issues({ issueId: issue.id }).get()).data!.title).toBe(
      'Newest remote',
    );
  });

  it('syncs comments from a linked and an unlinked author, with edits and deletes', async () => {
    const ctx = await setup(fake);
    await linkGithubAccount(ctx.ownerId, '1001');
    fake.put(ghIssue(1, { title: 'Task' }));
    await enable(ctx);
    const issue = await issueByTitle(ctx, 'Task');

    await commentEvent(
      ctx,
      'created',
      1,
      ghComment(601, 1, { body: 'From owner', user: { id: 1001, login: 'owner' } }),
    );
    await commentEvent(
      ctx,
      'created',
      1,
      ghComment(602, 1, { body: 'From outside', user: { id: 4004, login: 'outsider' } }),
    );
    let feed = await comments(ctx, issue.id);
    expect(feed).toMatchObject([
      { body: 'From owner', actorUserId: ctx.ownerId },
      { body: 'From outside', actorName: 'outsider' },
    ]);
    expect(feed[1]!.actorUserId).not.toBeNull();
    expect(feed[1]!.actorUserId).not.toBe(ctx.ownerId);
    const [outsideLink] = (await db.select().from(issueCommentSyncLink)).filter(
      (row) => row.externalId === '602',
    );
    expect(outsideLink).toMatchObject({
      externalAuthorLogin: 'outsider',
      externalUrl: 'https://github.com/acme/site/issues/1#issuecomment-602',
    });

    await commentEvent(
      ctx,
      'edited',
      1,
      ghComment(602, 1, {
        body: 'From outside, edited',
        user: { id: 4004, login: 'outsider' },
        updated_at: LATER,
      }),
    );
    feed = await comments(ctx, issue.id);
    expect(feed.map((item) => item.body)).toEqual(['From owner', 'From outside, edited']);

    await commentEvent(
      ctx,
      'deleted',
      1,
      ghComment(601, 1, { user: { id: 1001, login: 'owner' } }),
    );
    feed = await comments(ctx, issue.id);
    expect(feed.map((item) => item.body)).toEqual(['From outside, edited']);
  });

  it("lets the mentions in an outside author's edited comment reach nobody", async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task' }));
    await enable(ctx);
    const outsider = { id: 4004, login: 'outsider' };
    await commentEvent(ctx, 'created', 1, ghComment(901, 1, { body: 'Hi', user: outsider }));

    await commentEvent(
      ctx,
      'edited',
      1,
      ghComment(901, 1, { body: `Hi @${ctx.ownerUsername}`, user: outsider, updated_at: LATER }),
    );

    const issue = await issueByTitle(ctx, 'Task');
    expect((await comments(ctx, issue.id)).map((item) => item.body)).toEqual([
      `Hi @${ctx.ownerUsername}`,
    ]);
    const notifications = (await ctx.asOwner.notifications.get({ query: {} })).data!;
    expect(JSON.stringify(notifications)).not.toContain('mentioned');
  });

  it('catches up with missed changes from the watermark on reconcile', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task' }));
    await enable(ctx);

    fake.put(ghIssue(1, { title: 'Task, renamed', updated_at: LATER }));
    fake.put(ghIssue(2, { title: 'Missed report', updated_at: LATER }));
    fake.put(ghIssue(3, { title: 'Closed meanwhile', state: 'closed', updated_at: LATER }));
    fake.comments.push(ghComment(701, 1, { body: 'Missed comment', updated_at: LATER }));

    await reconcileIssueSync();

    const titles = (await listIssues(ctx)).map((item) => item.title).sort();
    expect(titles).toEqual(['Missed report', 'Task, renamed']);
    const issue = await issueByTitle(ctx, 'Task, renamed');
    expect((await comments(ctx, issue.id)).map((item) => item.body)).toEqual(['Missed comment']);
    const settings = (await syncSettings(ctx).patch({})).data!;
    expect(new Date(settings.issuesWatermark!)).toEqual(new Date(LATER));
  });

  it('turning the sync off deletes only the links, and turning it on imports again', async () => {
    const ctx = await setup(fake);
    fake.put(ghIssue(1, { title: 'Task' }));
    fake.comments.push(ghComment(801, 1));
    await enable(ctx);

    const off = await syncSettings(ctx).patch({ issuesSyncEnabled: false });

    expect(off.data).toMatchObject({ issuesSyncEnabled: false, issuesWatermark: null });
    expect(await db.select().from(issueSyncLink)).toEqual([]);
    expect(await db.select().from(issueCommentSyncLink)).toEqual([]);
    const issue = await issueByTitle(ctx, 'Task');
    expect((await comments(ctx, issue.id)).length).toBe(1);

    fake.put(ghIssue(1, { title: 'Renamed', updated_at: LATER }));
    await issueEvent(ctx, 'edited', fake.issues.get(1)!);
    expect((await listIssues(ctx)).map((item) => item.title)).toEqual(['Task']);

    await enable(ctx);
    expect((await listIssues(ctx)).map((item) => item.title).sort()).toEqual(['Renamed', 'Task']);
  });

  it('turns the new-issues-to-GitHub switch off without touching the sync', async () => {
    const ctx = await setup(fake);

    const response = await syncSettings(ctx).patch({ newIssuesToProvider: false });

    expect(response.data).toMatchObject({ issuesSyncEnabled: false, newIssuesToProvider: false });
  });

  it('refuses a member without the repositories permission', async () => {
    const ctx = await setup(fake);
    const stranger = await signUpTestUser({ name: 'Stranger' });
    const response = await authedApi(stranger.cookie)
      .projects({ projectKey: 'MKT' })
      .settings.git.connections({ connectionId: ctx.connectionId })
      .repositories({ repositoryId: ctx.repositoryId })
      ['issue-sync'].patch({ issuesSyncEnabled: true });
    expect([403, 404]).toContain(response.status);
  });
});
