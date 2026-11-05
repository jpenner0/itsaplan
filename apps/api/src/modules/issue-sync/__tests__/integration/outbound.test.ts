import { createHmac } from 'node:crypto';
import ExcelJS from 'exceljs';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { account, db, issueSyncLink, issueSyncOutbox } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { app } from '../../../../app';
import { authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { getProjectByRef } from '#modules/projects/service';
import { createMappedImport } from '#modules/imports/service';
import { processIssueSyncOutbox } from '../../outbound';
import { issueSyncSettled } from '../../queue';

// It's a Plan → GitHub issue sync against a GitHub served on localhost. As in the inbound
// tests, each case runs as development so the SSRF guard lets the fake provider through.

type Row = Record<string, unknown>;

function fakeGithub() {
  const issues = new Map<number, Row>();
  const comments = new Map<number, Row>();
  const labels: { name: string; color: string }[] = [];
  const calls: string[] = [];
  const state = {
    fail: false,
    // Only writes whose "METHOD path" matches fail; null means every write when `fail`.
    failOnly: null as RegExp | null,
    nextNumber: 1,
    nextComment: 500,
    fullName: 'acme/site',
    admin: true,
    transferred: new Set<number>(),
  };
  const prefix = '/api/v3';
  const now = () => new Date().toISOString();

  const touch = (row: Row) => {
    row.updated_at = now();
    return row;
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const requested = url.pathname.slice(prefix.length);
      // A renamed repository answers its old name with a redirect, as GitHub does.
      const current = `/repos/${state.fullName}`;
      if (requested.startsWith('/repos/') && !requested.startsWith(`${current}/`)) {
        return new Response(null, {
          status: 301,
          headers: { location: `${prefix}/repositories/1${requested.slice(current.length)}` },
        });
      }
      const path = requested.replace(current, '/repos/acme/site');
      const body = req.method === 'GET' ? null : ((await req.json().catch(() => null)) as Row);
      if (req.method !== 'GET') calls.push(`${req.method} ${path}`);
      if (
        state.fail &&
        req.method !== 'GET' &&
        (!state.failOnly || state.failOnly.test(`${req.method} ${path}`))
      ) {
        return Response.json({ message: 'Server Error' }, { status: 500 });
      }
      if (path === '/user') return Response.json({ login: 'octo' });
      if (path === '/user/3001') return Response.json({ id: 3001, login: 'owner-gh' });
      if (path === '/repositories/1') {
        return Response.json({
          id: 1,
          full_name: state.fullName,
          html_url: `https://github.com/${state.fullName}`,
          permissions: { admin: state.admin },
        });
      }
      if (path === '/repos/acme/site/hooks') {
        return req.method === 'GET'
          ? Response.json([])
          : Response.json({ id: 1, config: { url: 'x' } }, { status: 201 });
      }
      if (path === '/repos/acme/site/labels') {
        if (req.method === 'GET') return Response.json(labels);
        labels.push({ name: body!.name as string, color: body!.color as string });
        return Response.json(body, { status: 201 });
      }
      if (path === '/repos/acme/site/issues') {
        if (req.method === 'GET') return Response.json([...issues.values()]);
        const number = state.nextNumber++;
        const row: Row = {
          id: 9000 + number,
          number,
          title: body!.title,
          body: body!.body ?? '',
          state: 'open',
          state_reason: null,
          html_url: `https://github.com/acme/site/issues/${number}`,
          repository_url: 'https://api.github.com/repos/acme/site',
          user: { id: 1, login: 'octo' },
          assignees: ((body!.assignees as string[]) ?? []).map((login) => ({ id: 3001, login })),
          labels: ((body!.labels as string[]) ?? []).map((name) => ({ name })),
          created_at: now(),
          updated_at: now(),
        };
        issues.set(number, row);
        return Response.json(row, { status: 201 });
      }
      if (path === '/repos/acme/site/issues/comments') return Response.json([]);
      const issueMatch = path.match(/^\/repos\/acme\/site\/issues\/(\d+)(\/\w+)?$/);
      if (issueMatch) {
        const number = Number(issueMatch[1]);
        if (state.transferred.has(number)) {
          return new Response(null, {
            status: 301,
            headers: { location: `${prefix}/repositories/2/issues/7` },
          });
        }
        const row = issues.get(number);
        if (!row) return Response.json({ message: 'Not Found' }, { status: 404 });
        row.repository_url = `https://api.github.com/repos/${state.fullName}`;
        const sub = issueMatch[2];
        if (!sub && req.method === 'GET') return Response.json(row);
        if (!sub && req.method === 'PATCH') {
          if (body!.title !== undefined) row.title = body!.title;
          if (body!.body !== undefined) row.body = body!.body;
          if (body!.state !== undefined) {
            row.state = body!.state;
            row.state_reason =
              body!.state === 'closed' ? (body!.state_reason ?? 'completed') : null;
          }
          if (body!.labels !== undefined) {
            row.labels = (body!.labels as string[]).map((name) => ({ name }));
          }
          return Response.json(touch(row));
        }
        if (sub === '/assignees') {
          const logins = body!.assignees as string[];
          row.assignees = [
            ...(row.assignees as Row[]),
            ...logins.map((login) => ({ id: 3001, login })),
          ];
          return Response.json(touch(row));
        }
        if (sub === '/comments') {
          const id = state.nextComment++;
          const comment: Row = {
            id,
            body: body!.body,
            html_url: `https://github.com/acme/site/issues/${number}#issuecomment-${id}`,
            issue_url: `https://api.github.com/repos/acme/site/issues/${number}`,
            user: { id: 1, login: 'octo' },
            created_at: now(),
            updated_at: now(),
          };
          comments.set(id, comment);
          return Response.json(comment, { status: 201 });
        }
      }
      const commentMatch = path.match(/^\/repos\/acme\/site\/issues\/comments\/(\d+)$/);
      if (commentMatch) {
        const id = Number(commentMatch[1]);
        const comment = comments.get(id);
        if (!comment) return Response.json({ message: 'Not Found' }, { status: 404 });
        if (req.method === 'DELETE') {
          comments.delete(id);
          return new Response(null, { status: 204 });
        }
        comment.body = body!.body;
        return Response.json(touch(comment));
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    issues,
    comments,
    labels,
    calls,
    state,
    writes: (pattern: RegExp) => calls.filter((call) => pattern.test(call)),
    stop: () => server.stop(true),
  };
}

type Fake = ReturnType<typeof fakeGithub>;

interface Ctx {
  key: string;
  asOwner: Api;
  ownerId: string;
  teamId: number;
  connectionId: number;
  repositoryId: number;
  webhookId: string;
  secret: string;
  columns: { id: number; stateType: string; name: string }[];
}

async function setup(fake: Fake, key = 'MKT'): Promise<Ctx> {
  const user = await signUpTestUser({ name: 'Owner' });
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
    key,
    asOwner,
    ownerId: user.userId,
    teamId,
    connectionId,
    repositoryId: connected.data!.repositories[0]!.id,
    webhookId: settings.webhookId,
    secret: settings.secret,
    columns: view.columns,
  };
}

async function enable(ctx: Ctx, patch: { newIssuesToProvider?: boolean } = {}) {
  const response = await ctx.asOwner
    .projects({ projectKey: ctx.key })
    .settings.git.connections({ connectionId: ctx.connectionId })
    .repositories({ repositoryId: ctx.repositoryId })
    ['issue-sync'].patch({ issuesSyncEnabled: true, ...patch });
  expect(response.status).toBe(200);
}

const columnOf = (ctx: Ctx, stateType: string, nth = 0) =>
  ctx.columns.filter((column) => column.stateType === stateType)[nth]!.id;

async function createIssue(ctx: Ctx, title = 'Task', extra: Row = {}) {
  const created = await ctx.asOwner
    .projects({ projectKey: ctx.key })
    .issues.post({ title, columnId: columnOf(ctx, 'unstarted'), ...extra });
  expect(created.status).toBe(201);
  await issueSyncSettled();
  return created.data!;
}

async function patchIssue(ctx: Ctx, issueId: number, body: Row) {
  const updated = await ctx.asOwner.issues({ issueId }).patch(body);
  expect(updated.status).toBe(200);
  await issueSyncSettled();
}

async function linkOf(issueId: number) {
  const [link] = await db.select().from(issueSyncLink).where(eq(issueSyncLink.issueId, issueId));
  return link;
}

async function linkGithubAccount(userId: string) {
  await db.insert(account).values({
    id: crypto.randomUUID(),
    userId,
    providerId: 'github',
    accountId: '3001',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function deliver(ctx: Ctx, event: string, payload: Row) {
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
  await issueSyncSettled();
}

describe('GitHub issue sync, outbound', () => {
  const environment = { ...process.env };
  let fake: Fake;

  beforeEach(async () => {
    await resetDb();
    process.env.NODE_ENV = 'development';
    fake = fakeGithub();
  });

  afterEach(async () => {
    await issueSyncSettled();
    fake.stop();
    process.env.NODE_ENV = environment.NODE_ENV;
  });

  it('creates a new issue on GitHub with the footer and links it', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx, 'Broken login', { description: 'Steps' });

    const external = fake.issues.get(1)!;
    expect(external.title).toBe('Broken login');
    expect(external.body).toMatch(
      new RegExp(
        `^Steps\\n\\nTracked in It's a Plan: \\[MKT-\\d+\\]\\(http\\S+/issue/MKT-\\d+\\)$`,
      ),
    );
    expect(await linkOf(created.id)).toMatchObject({ externalNumber: 1 });
    const detail = (await ctx.asOwner.issues({ issueId: created.id }).get()).data!;
    expect(detail.development).toMatchObject([
      { kind: 'issue', provider: 'github', repository: 'acme/site', number: 1, state: 'open' },
    ]);
  });

  it('does not create new issues on GitHub when the toggle is off', async () => {
    const ctx = await setup(fake);
    await enable(ctx, { newIssuesToProvider: false });
    const created = await createIssue(ctx);

    expect(fake.writes(/^POST \/repos\/acme\/site\/issues$/)).toHaveLength(0);
    expect(await linkOf(created.id)).toBeUndefined();
  });

  it('publishes an existing issue, and refuses one already linked or without sync', async () => {
    const ctx = await setup(fake);
    const before = await createIssue(ctx, 'Old issue');
    const unsynced = await ctx.asOwner.issues({ issueId: before.id }).publish.post();
    expect(unsynced.status).toBe(409);

    await enable(ctx, { newIssuesToProvider: false });
    expect(fake.writes(/^POST \/repos\/acme\/site\/issues$/)).toHaveLength(0);
    const published = await ctx.asOwner.issues({ issueId: before.id }).publish.post();
    expect(published.status).toBe(201);
    expect(published.data).toMatchObject({ issueId: before.id, externalNumber: 1 });
    expect(fake.issues.get(1)!.title).toBe('Old issue');

    const again = await ctx.asOwner.issues({ issueId: before.id }).publish.post();
    expect(again.status).toBe(409);
  });

  it('refuses publish to a user outside the project', async () => {
    const ctx = await setup(fake);
    await enable(ctx, { newIssuesToProvider: false });
    const created = await createIssue(ctx);
    const outsider = authedApi((await signUpTestUser({ name: 'Outsider' })).cookie);
    const response = await outsider.issues({ issueId: created.id }).publish.post();
    expect(response.status).toBe(403);
    expect(fake.issues.size).toBe(0);
  });

  it('sends title and description, with uploaded images as links', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    await patchIssue(ctx, created.id, {
      title: 'New title',
      description: 'See ![shot.png](/media/attachments/abc/raw)',
    });

    const external = fake.issues.get(1)!;
    expect(external.title).toBe('New title');
    expect(external.body).toStartWith(
      "See [📎 shot.png (view in It's a Plan)](http://localhost:3001/media/attachments/abc/raw)\n\nTracked in It's a Plan: [MKT-",
    );
  });

  it('maps the status, and does not send a move between open columns', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    const otherOpen = ctx.columns.find(
      (column) => !['completed', 'canceled', 'unstarted'].includes(column.stateType),
    )!;

    await patchIssue(ctx, created.id, { columnId: otherOpen.id });
    expect(fake.writes(/^PATCH \/repos\/acme\/site\/issues\/1$/)).toHaveLength(0);

    await patchIssue(ctx, created.id, { columnId: columnOf(ctx, 'completed') });
    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'completed' });

    await patchIssue(ctx, created.id, { columnId: columnOf(ctx, 'canceled') });
    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });

    await patchIssue(ctx, created.id, { columnId: otherOpen.id });
    expect(fake.issues.get(1)).toMatchObject({ state: 'open' });
  });

  it('sends labels by name and creates a missing label with its colour', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    fake.labels.push({ name: 'bug', color: 'd73a4a' });
    const project = ctx.asOwner.projects({ projectKey: 'MKT' });
    const bug = (await project.labels.post({ name: 'Bug', color: '#d73a4a' })).data!;
    const docs = (await project.labels.post({ name: 'docs', color: '#0075ca' })).data!;
    const created = await createIssue(ctx);

    await patchIssue(ctx, created.id, { labelIds: [bug.id, docs.id] });

    expect(fake.labels).toEqual([
      { name: 'bug', color: 'd73a4a' },
      { name: 'docs', color: '0075ca' },
    ]);
    expect((fake.issues.get(1)!.labels as Row[]).map((item) => item.name).sort()).toEqual([
      'Bug',
      'docs',
    ]);
  });

  it('adds the assignee only when their GitHub account is linked', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);

    await patchIssue(ctx, created.id, { assigneeUserId: ctx.ownerId });
    expect(fake.writes(/\/assignees$/)).toHaveLength(0);
    expect(fake.issues.get(1)!.assignees).toEqual([]);

    await patchIssue(ctx, created.id, { assigneeUserId: null });
    await linkGithubAccount(ctx.ownerId);
    await patchIssue(ctx, created.id, { assigneeUserId: ctx.ownerId });
    expect(fake.issues.get(1)!.assignees).toEqual([{ id: 3001, login: 'owner-gh' }]);
  });

  it('creates, edits and deletes comments with the header', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    await linkGithubAccount(ctx.ownerId);

    const comment = await ctx.asOwner.issues({ issueId: created.id }).comments.post({ body: 'Hi' });
    expect(comment.status).toBe(201);
    await issueSyncSettled();
    const [external] = [...fake.comments.values()];
    expect(external!.body).toBe("**Owner** (@owner-gh, via It's a Plan):\n\nHi");

    const reply = await ctx.asOwner
      .issues({ issueId: created.id })
      .comments.post({ body: 'Reply', replyToId: comment.data!.id });
    expect(reply.status).toBe(201);
    await issueSyncSettled();
    expect(fake.comments.size).toBe(2);

    const edited = await ctx.asOwner
      .comments({ commentId: comment.data!.id })
      .patch({ body: 'Hey' });
    expect(edited.status).toBe(200);
    await issueSyncSettled();
    expect(fake.comments.get(external!.id as number)!.body).toBe(
      "**Owner** (@owner-gh, via It's a Plan):\n\nHey",
    );

    // Deleting the parent removes its reply as well, on both sides.
    const removed = await ctx.asOwner.comments({ commentId: comment.data!.id }).delete();
    expect(removed.status).toBe(204);
    await issueSyncSettled();
    expect(fake.comments.size).toBe(0);
  });

  it('writes the header without a login when the account is not linked', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    await ctx.asOwner.issues({ issueId: created.id }).comments.post({ body: 'Hi' });
    await issueSyncSettled();
    expect([...fake.comments.values()][0]!.body).toBe("**Owner** (via It's a Plan):\n\nHi");
  });

  it('drops the header when a comment it posted is edited on GitHub', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    const comment = await ctx.asOwner.issues({ issueId: created.id }).comments.post({ body: 'Hi' });
    await issueSyncSettled();
    const [external] = [...fake.comments.values()];
    external!.body = "**Owner** (via It's a Plan):\n\nChanged on GitHub";
    external!.updated_at = new Date(Date.now() + 1000).toISOString();
    fake.calls.length = 0;

    await deliver(ctx, 'issue_comment', {
      action: 'edited',
      issue: { number: 1 },
      comment: external,
    });
    await processIssueSyncOutbox();

    const feed = await ctx.asOwner
      .issues({ issueId: created.id })
      .feed.get({ query: { filter: 'comments', order: 'asc' } });
    expect(feed.data!.items.find((item) => item.id === comment.data!.id)!.body).toBe(
      'Changed on GitHub',
    );
    expect(fake.calls).toEqual([]);
  });

  it('closes the GitHub issue as not planned when the issue is deleted', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    const removed = await ctx.asOwner.issues({ issueId: created.id }).delete({});
    expect(removed.status).toBe(204);
    await issueSyncSettled();

    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });

  it('closes GitHub issues deleted in bulk and with their project', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const first = await createIssue(ctx, 'One');
    await createIssue(ctx, 'Two');

    const bulk = await ctx.asOwner
      .projects({ projectKey: 'MKT' })
      .issues.bulk.delete.post({ ids: [first.id] });
    expect(bulk.status).toBe(200);
    await issueSyncSettled();
    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(fake.issues.get(2)).toMatchObject({ state: 'open' });

    const removed = await ctx.asOwner.projects({ projectKey: 'MKT' }).delete();
    expect(removed.status).toBe(204);
    await processIssueSyncOutbox();
    expect(fake.issues.get(2)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
  });

  it('keeps the GitHub issue open when sync is turned off', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    await createIssue(ctx);
    const off = await ctx.asOwner
      .projects({ projectKey: 'MKT' })
      .settings.git.connections({ connectionId: ctx.connectionId })
      .repositories({ repositoryId: ctx.repositoryId })
      ['issue-sync'].patch({ issuesSyncEnabled: false });
    expect(off.status).toBe(200);
    await processIssueSyncOutbox();

    expect(fake.issues.get(1)).toMatchObject({ state: 'open' });
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });

  it('does not send back a change that came from GitHub', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    const external = fake.issues.get(1)!;
    external.title = 'Renamed on GitHub';
    external.labels = [{ name: 'triage', color: 'ededed' }];
    external.updated_at = new Date(Date.now() + 1000).toISOString();
    fake.calls.length = 0;

    await deliver(ctx, 'issues', { action: 'edited', issue: external });
    await issueSyncSettled();
    await processIssueSyncOutbox();

    const detail = (await ctx.asOwner.issues({ issueId: created.id }).get()).data!;
    expect(detail.title).toBe('Renamed on GitHub');
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });

  it('leaves a push for a repository another sync holds to the next run', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    fake.state.fail = true;
    await patchIssue(ctx, created.id, { title: 'Busy edit' });
    fake.state.fail = false;
    await db.update(issueSyncOutbox).set({ nextAttemptAt: sql`now()` });

    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(8251, ${ctx.repositoryId})`);
      await processIssueSyncOutbox();
    });
    const [queued] = await db.select().from(issueSyncOutbox);
    expect(queued).toMatchObject({ kind: 'issue', attempts: 1 });
    expect(fake.issues.get(1)!.title).toBe('Task');

    await processIssueSyncOutbox();
    expect(fake.issues.get(1)!.title).toBe('Busy edit');
  });

  it('follows a renamed repository and keeps the issue linked', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    fake.state.fullName = 'acme/site-renamed';

    await patchIssue(ctx, created.id, { title: 'After rename' });
    expect(await linkOf(created.id)).toBeDefined();
    const [queued] = await db.select().from(issueSyncOutbox);
    expect(queued).toMatchObject({ kind: 'issue', attempts: 1 });

    await db.update(issueSyncOutbox).set({ nextAttemptAt: sql`now()` });
    await processIssueSyncOutbox();
    expect(fake.issues.get(1)!.title).toBe('After rename');
    expect(await linkOf(created.id)).toBeDefined();
    const detail = (await ctx.asOwner.issues({ issueId: created.id }).get()).data!;
    expect(detail.columnId).toBe(columnOf(ctx, 'unstarted'));
  });

  it('unlinks and cancels an issue that was transferred to another repository', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    fake.state.transferred.add(1);

    await patchIssue(ctx, created.id, { title: 'After transfer' });

    expect(await linkOf(created.id)).toBeUndefined();
    const detail = (await ctx.asOwner.issues({ issueId: created.id }).get()).data!;
    expect(detail.columnId).toBe(columnOf(ctx, 'canceled'));
    expect(fake.issues.get(1)!.title).toBe('Task');
  });

  it('closes the GitHub issue under the new name after the repository was renamed', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    fake.state.fullName = 'acme/site-renamed';

    const removed = await ctx.asOwner.issues({ issueId: created.id }).delete({});
    expect(removed.status).toBe(204);
    await issueSyncSettled();

    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });

  it('closes the GitHub issue when the token has no admin right on the repository', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    fake.state.admin = false;

    const removed = await ctx.asOwner.issues({ issueId: created.id }).delete({});
    expect(removed.status).toBe(204);
    await issueSyncSettled();

    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });

  it('does not create a second GitHub issue when closing a published issue fails', async () => {
    const ctx = await setup(fake);
    await enable(ctx, { newIssuesToProvider: false });
    const created = await createIssue(ctx);
    await patchIssue(ctx, created.id, { columnId: columnOf(ctx, 'completed') });
    fake.state.fail = true;
    fake.state.failOnly = /^PATCH \/repos\/acme\/site\/issues\/\d+$/;

    const published = await ctx.asOwner.issues({ issueId: created.id }).publish.post();
    expect(published.status).toBe(201);
    expect(fake.issues.get(1)).toMatchObject({ state: 'open' });
    expect(await db.select().from(issueSyncOutbox)).toMatchObject([
      { kind: 'issue', issueId: created.id },
    ]);

    fake.state.fail = false;
    await db.update(issueSyncOutbox).set({ nextAttemptAt: sql`now()` });
    await processIssueSyncOutbox();
    expect(fake.writes(/^POST \/repos\/acme\/site\/issues$/)).toHaveLength(1);
    expect(fake.issues.get(1)).toMatchObject({ state: 'closed', state_reason: 'completed' });
  });

  it('does not let a busy repository hold back the pushes of another one', async () => {
    const other = fakeGithub();
    try {
      const ctx = await setup(fake);
      const otherCtx = await setup(other, 'OTH');
      await enable(ctx);
      await enable(otherCtx);
      const busy = await createIssue(ctx);
      const free = await createIssue(otherCtx);

      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(8251, ${ctx.repositoryId})`);
        await patchIssue(ctx, busy.id, { title: 'Waits' });
        await patchIssue(otherCtx, free.id, { title: 'Sent' });
        expect(other.issues.get(1)!.title).toBe('Sent');
        expect(fake.issues.get(1)!.title).toBe('Task');
      });

      await processIssueSyncOutbox();
      expect(fake.issues.get(1)!.title).toBe('Waits');
    } finally {
      await issueSyncSettled();
      other.stop();
    }
  });

  it('does not send issues created by an import to GitHub', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Tasks');
    sheet.addRow(['Task']);
    sheet.addRow(['Imported']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const uploaded = await ctx.asOwner.projects({ projectKey: 'MKT' })['chat-attachments'].post({
      filename: 'tasks.xlsx',
      contentBase64: bytes.toString('base64'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(uploaded.status).toBe(201);
    const project = await getProjectByRef('MKT', '');
    const draft = await createMappedImport(project!.id, uploaded.data!.id, { title: 'Task' });

    const confirm = await ctx.asOwner.imports({ importId: draft.id }).confirm.post();
    expect(confirm.status).toBe(200);
    expect(confirm.data!.imported).toHaveLength(1);
    await issueSyncSettled();
    await processIssueSyncOutbox();

    expect(fake.issues.size).toBe(0);
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });

  it('keeps the local change when GitHub fails and sends it on a later run', async () => {
    const ctx = await setup(fake);
    await enable(ctx);
    const created = await createIssue(ctx);
    fake.state.fail = true;

    await patchIssue(ctx, created.id, { title: 'Offline edit' });
    const detail = (await ctx.asOwner.issues({ issueId: created.id }).get()).data!;
    expect(detail.title).toBe('Offline edit');
    const [queued] = await db.select().from(issueSyncOutbox);
    expect(queued).toMatchObject({ kind: 'issue', issueId: created.id, attempts: 1 });
    expect(queued!.lastError).toBeTruthy();

    fake.state.fail = false;
    await processIssueSyncOutbox();
    expect(fake.issues.get(1)!.title).toBe('Task');

    // The retry is due now. The time comes from the database, whose clock the check uses.
    await db.update(issueSyncOutbox).set({ nextAttemptAt: sql`now()` });
    await processIssueSyncOutbox();
    expect(fake.issues.get(1)!.title).toBe('Offline edit');
    expect(await db.select().from(issueSyncOutbox)).toEqual([]);
  });
});
