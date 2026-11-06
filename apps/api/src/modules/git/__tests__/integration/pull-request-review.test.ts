import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { agentRun, db, issueSyncLink } from '@repo/db';
import { app } from '../../../../app';
import { authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createAgent, projectIdOf } from '#tests/helpers/agents';

// A GitHub pull request that names an issue synced with its repository starts the
// project's pull_request_opened schedules once, when it is opened or marked ready.
// The repository is served on localhost; the SSRF guard refuses http and loopback hosts
// under NODE_ENV=test, so each case runs as development.

const WEB_URL = 'https://github.example/acme/site';

function fakeGitHub() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/api\/v3/, '');
      if (path === '/user') return Response.json({ login: 'octo' });
      if (path === '/repositories/1') {
        return Response.json({
          id: 1,
          full_name: 'acme/site',
          html_url: WEB_URL,
          permissions: { admin: true },
        });
      }
      if (path === '/repos/acme/site/hooks') {
        return req.method === 'GET'
          ? Response.json([])
          : Response.json({ id: 1, config: { url: 'x' } }, { status: 201 });
      }
      if (path === '/repos/acme/site/pulls/7') return new Response('diff --git a/x b/x\n');
      if (path === '/repos/acme/site/issues/7/comments')
        return Response.json({ id: 1 }, { status: 201 });
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

type Fake = ReturnType<typeof fakeGitHub>;

const schedules = (api: Api, projectKey = 'MKT') => api.projects({ projectKey })['agent-schedules'];

async function connectRepository(api: Api, projectKey: string, connectionId: number) {
  const connected = await api
    .projects({ projectKey })
    .settings.git.connections({ connectionId })
    .repositories.post({ externalIds: ['1'] });
  expect(connected.status).toBe(200);
  return connected.data!.repositories[0]!.id;
}

async function createIssue(api: Api, projectKey = 'MKT') {
  const view = await api.projects({ projectKey }).get();
  const created = await api
    .projects({ projectKey })
    .issues.post({ columnId: view.data!.columns[0].id, title: 'Task' });
  return created.data!;
}

// The import is the only way to a synced issue, and it reads the whole repository; a
// link row is the state these cases need.
async function syncIssue(issueId: number, repositoryId: number, number: number) {
  await db.insert(issueSyncLink).values({
    issueId,
    managedRepositoryId: repositoryId,
    externalId: String(9000 + number),
    externalNumber: number,
    externalUrl: `${WEB_URL}/issues/${number}`,
    syncedHash: 'hash',
    externalUpdatedAt: new Date(),
  });
}

// MKT manages acme/site, has its pull request integration on and a review schedule.
async function setup(fake: Fake) {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  const created = await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  await createProject(asOwner, { key: 'OPS', name: 'Operations' });
  const settings = await asOwner.projects({ projectKey: 'MKT' }).settings.git.get();
  await asOwner.projects({ projectKey: 'MKT' }).settings.git.patch({ enabled: true });
  const connection = await asOwner
    .teams({ teamId: created.data!.teamId })
    .settings.git.connections.post({ provider: 'github', baseUrl: fake.baseUrl, token: 'tok-1' });
  const repositoryId = await connectRepository(asOwner, 'MKT', connection.data!.id);
  const agent = (
    await createAgent(asOwner, 'MKT', {
      name: 'Reviewer',
      username: 'reviewer',
      kind: 'external',
      projectIds: [await projectIdOf(asOwner, 'MKT'), await projectIdOf(asOwner, 'OPS')],
    })
  ).data!.agent;
  const schedule = (
    await schedules(asOwner).post({
      agentId: agent.id,
      name: 'Review',
      type: 'pull_request_opened',
      prompt: 'Be brief.',
    })
  ).data!;
  return {
    asOwner,
    agent,
    connectionId: connection.data!.id,
    repositoryId,
    schedule,
    webhookId: settings.data!.webhookId,
    secret: settings.data!.secret!,
  };
}

function prPayload(overrides: {
  action?: string;
  draft?: boolean;
  title?: string;
  body?: string;
  headRef?: string;
  repo?: string;
}) {
  return {
    action: overrides.action ?? 'opened',
    pull_request: {
      number: 7,
      title: overrides.title ?? 'Add greeting',
      body: overrides.body ?? null,
      html_url: `${WEB_URL}/pull/7`,
      merged: false,
      draft: overrides.draft ?? false,
      base: { ref: 'main' },
      head: { ref: overrides.headRef ?? 'greeting', sha: 'abc123' },
    },
    repository: { full_name: overrides.repo ?? 'acme/site', default_branch: 'main' },
  };
}

async function deliver(
  setup: { webhookId: string; secret: string },
  payload: unknown,
  deliveryId: string = crypto.randomUUID(),
) {
  const body = JSON.stringify(payload);
  const res = await app.handle(
    new Request(`http://localhost/webhooks/git/${setup.webhookId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': `sha256=${createHmac('sha256', setup.secret).update(body).digest('hex')}`,
        'x-github-delivery': deliveryId,
      },
      body,
    }),
  );
  return { status: res.status, data: (await res.json()) as unknown };
}

// The run DTO has no issue, so the queued rows are read.
const runs = () =>
  db
    .select({
      issueId: agentRun.issueId,
      projectId: agentRun.projectId,
      scheduleId: agentRun.scheduleId,
      trigger: agentRun.trigger,
      prompt: agentRun.prompt,
    })
    .from(agentRun)
    .orderBy(agentRun.id);

async function developmentOf(api: Api, issueId: number) {
  return (await api.issues({ issueId }).get()).data!.development;
}

describe('review runs for pull requests', () => {
  const nodeEnv = process.env.NODE_ENV;
  let fake: Fake;

  beforeEach(async () => {
    await resetDb();
    process.env.NODE_ENV = 'development';
    fake = fakeGitHub();
  });

  afterEach(() => {
    fake.stop();
    process.env.NODE_ENV = nodeEnv;
  });

  it('links the pull request and queues one run on an issue named with a closing word', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    const res = await deliver(ctx, prPayload({ body: 'Fixes #11' }));

    expect(res).toMatchObject({ status: 200, data: { handled: 'opened' } });
    const development = await developmentOf(ctx.asOwner, issue.id);
    const link = development.find((item) => item.kind === 'pull_request')!;
    expect(link).toMatchObject({ repository: 'acme/site', number: 7, state: 'open' });
    const queued = await runs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      issueId: issue.id,
      scheduleId: ctx.schedule.id,
      trigger: 'event',
    });
    expect(queued[0]!.prompt).toBe(
      `Pull request acme/site#7 (${WEB_URL}/pull/7) references work item ${issue.identifier}. ` +
        `Review it: read the diff with get_pull_request_diff (issueId ${issue.id}, linkId ` +
        `${link.id}) and post one review comment with comment_on_pull_request. ` +
        'Do not approve or request changes.\n\nBe brief.',
    );
    expect(queued[0]!.prompt).not.toContain('Add greeting');
  });

  it('gives the run a link id that reads the diff of the pull request', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ title: 'Closes acme/site#11' }));

    const [run] = await runs();
    const linkId = Number(run!.prompt.match(/linkId (\d+)/)![1]);
    const diff = await ctx.asOwner.issues({ issueId: issue.id }).development({ linkId }).diff.get();
    expect(diff.status).toBe(200);
    expect(diff.data).toMatchObject({ repository: 'acme/site', number: 7 });
  });

  it('resolves the issue URL of the repository', async () => {
    const ctx = await setup(fake);
    const byUrl = await createIssue(ctx.asOwner);
    await syncIssue(byUrl.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: `See ${WEB_URL}/issues/11` }));
    expect(await runs()).toHaveLength(1);
  });

  it('queues a run when a draft is marked ready, but none for the draft', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: 'Fixes #11', draft: true }));
    expect(await runs()).toHaveLength(0);
    expect(await developmentOf(ctx.asOwner, issue.id)).toContainEqual(
      expect.objectContaining({ kind: 'pull_request', draft: true }),
    );

    await deliver(ctx, prPayload({ action: 'ready_for_review', body: 'Fixes #11' }));
    expect(await runs()).toHaveLength(1);
  });

  it('queues one run when a reviewed pull request goes back to draft and is ready again', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: 'Fixes #11' }));
    await deliver(ctx, prPayload({ action: 'converted_to_draft', body: 'Fixes #11', draft: true }));
    await deliver(ctx, prPayload({ action: 'ready_for_review', body: 'Fixes #11' }));

    expect(await runs()).toHaveLength(1);
  });

  it('queues one run for a draft marked ready twice, also once the run has finished', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: 'Fixes #11', draft: true }));
    await deliver(ctx, prPayload({ action: 'ready_for_review', body: 'Fixes #11' }));
    await db.update(agentRun).set({ status: 'success' });
    await deliver(ctx, prPayload({ action: 'converted_to_draft', body: 'Fixes #11', draft: true }));
    await deliver(ctx, prPayload({ action: 'ready_for_review', body: 'Fixes #11' }));

    expect(await runs()).toHaveLength(1);
  });

  it('queues no second run when the repository name differs in case', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: 'Fixes #11' }));
    await deliver(ctx, prPayload({ action: 'converted_to_draft', body: 'Fixes #11', draft: true }));
    await deliver(
      ctx,
      prPayload({ action: 'ready_for_review', body: 'Fixes #11', repo: 'Acme/Site' }),
    );

    expect(await runs()).toHaveLength(1);
  });

  it('queues a run for another pull request on a reviewed issue', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: 'Fixes #11' }));
    const other = prPayload({ body: 'Fixes #11', headRef: 'farewell' });
    other.pull_request.number = 70;
    other.pull_request.html_url = `${WEB_URL}/pull/70`;
    await deliver(ctx, other);

    expect((await runs()).map((run) => run.prompt.split(' (')[0])).toEqual([
      'Pull request acme/site#7',
      'Pull request acme/site#70',
    ]);
  });

  it('queues no run on a push, a reopen or an edit', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    for (const action of ['synchronize', 'reopened', 'edited'])
      await deliver(ctx, prPayload({ action, body: 'Fixes #11' }));

    expect(await runs()).toHaveLength(0);
    // The link is still made, as for a project key.
    expect(await developmentOf(ctx.asOwner, issue.id)).toContainEqual(
      expect.objectContaining({ kind: 'pull_request', number: 7 }),
    );
  });

  it('queues no run and makes no link for a number with no synced issue', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(ctx, prPayload({ body: `Fixes #12, ${issue.identifier.replace(/\d+$/, '99')}` }));

    expect(await runs()).toHaveLength(0);
    expect(await developmentOf(ctx.asOwner, issue.id)).toEqual([]);
  });

  it('queues no run for an issue that is not synced, named by its key', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);

    await deliver(ctx, prPayload({ body: `Fixes ${issue.identifier}` }));

    expect(await runs()).toHaveLength(0);
    expect(await developmentOf(ctx.asOwner, issue.id)).toHaveLength(1);
  });

  it('ignores a reference to another repository', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);

    await deliver(
      ctx,
      prPayload({ body: 'Fixes acme/other#11 and https://github.example/acme/other/issues/11' }),
    );
    // The same number in a pull request of a repository the project does not manage.
    await deliver(ctx, prPayload({ body: 'Fixes #11', repo: 'acme/other' }));

    expect(await runs()).toHaveLength(0);
    expect(await developmentOf(ctx.asOwner, issue.id)).toEqual([]);
  });

  it('queues one run for a redelivered webhook', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);
    const deliveryId = crypto.randomUUID();

    await deliver(ctx, prPayload({ body: 'Fixes #11' }), deliveryId);
    const again = await deliver(ctx, prPayload({ body: 'Fixes #11' }), deliveryId);

    expect(again.data).toMatchObject({ handled: 'duplicate' });
    expect(await runs()).toHaveLength(1);
  });

  it('queues one run on the first synced issue and names the others', async () => {
    const ctx = await setup(fake);
    const plain = await createIssue(ctx.asOwner);
    const first = await createIssue(ctx.asOwner);
    const second = await createIssue(ctx.asOwner);
    await syncIssue(first.id, ctx.repositoryId, 11);
    await syncIssue(second.id, ctx.repositoryId, 12);

    await deliver(ctx, prPayload({ body: `Fixes ${plain.identifier}, #12 and #11` }));

    const queued = await runs();
    expect(queued).toHaveLength(1);
    // A project key comes before GitHub's references, which keep their order.
    expect(queued[0]!.issueId).toBe(second.id);
    expect(queued[0]!.prompt).toContain(
      `references work item ${second.identifier}, and also ${plain.identifier}, ${first.identifier}.`,
    );
    for (const issue of [plain, first, second])
      expect(await developmentOf(ctx.asOwner, issue.id)).toHaveLength(1);
  });

  it('queues one run per project when the issues are in two projects', async () => {
    const ctx = await setup(fake);
    await connectRepository(ctx.asOwner, 'OPS', ctx.connectionId);
    const opsSchedule = (
      await schedules(ctx.asOwner, 'OPS').post({
        agentId: ctx.agent.id,
        name: 'Review',
        type: 'pull_request_opened',
      })
    ).data!;
    const stays = await createIssue(ctx.asOwner);
    const moves = await createIssue(ctx.asOwner);
    await syncIssue(stays.id, ctx.repositoryId, 11);
    await syncIssue(moves.id, ctx.repositoryId, 12);
    const opsId = await projectIdOf(ctx.asOwner, 'OPS');
    expect(
      (await ctx.asOwner.issues({ issueId: moves.id }).move.post({ projectId: opsId })).status,
    ).toBe(200);

    // The moved issue is named by its old key, which still resolves.
    await deliver(ctx, prPayload({ body: `Fixes ${moves.identifier} and #11` }));

    const queued = await runs();
    expect(queued.map((run) => [run.scheduleId, run.issueId])).toEqual([
      [opsSchedule.id, moves.id],
      [ctx.schedule.id, stays.id],
    ]);
  });

  it('queues no run without an active schedule', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);
    await schedules(ctx.asOwner)({ scheduleId: ctx.schedule.id }).patch({ status: 'paused' });

    await deliver(ctx, prPayload({ body: 'Fixes #11' }));
    expect(await runs()).toHaveLength(0);

    await schedules(ctx.asOwner)({ scheduleId: ctx.schedule.id }).delete();
    await deliver(ctx, prPayload({ action: 'ready_for_review', body: 'Fixes #11' }));
    expect(await runs()).toHaveLength(0);
  });

  it('queues no run while the pull request integration is off', async () => {
    const ctx = await setup(fake);
    const issue = await createIssue(ctx.asOwner);
    await syncIssue(issue.id, ctx.repositoryId, 11);
    await ctx.asOwner.projects({ projectKey: 'MKT' }).settings.git.patch({ enabled: false });

    const res = await deliver(ctx, prPayload({ body: 'Fixes #11' }));

    expect(res.data).toMatchObject({ handled: 'disabled' });
    expect(await runs()).toHaveLength(0);
  });
});
