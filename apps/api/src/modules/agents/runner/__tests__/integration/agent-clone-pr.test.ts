import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { agentRun, db, issueSyncLink } from '@repo/db';
import { eq } from 'drizzle-orm';
import { apiKeyApi, authedApi, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createAgent } from '#tests/helpers/agents';
import { branchName } from '../../repository';

// A delegated issue that is synced with a repository: the claim carries the repository,
// and the branch the runner reports opens a pull request with the team's token. GitHub is
// a server on localhost, and each case runs as development so the SSRF guard lets it in.

function fakeGithub() {
  const pulls: Record<string, unknown>[] = [];
  const state = { pullStatus: 201, pullMessage: '' };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.slice('/api/v3'.length);
      if (path === '/user') return Response.json({ login: 'octo' });
      if (path === '/repositories/1') {
        return Response.json({
          id: 1,
          full_name: 'acme/site',
          html_url: 'https://github.com/acme/site',
          default_branch: 'trunk',
          permissions: { admin: true },
        });
      }
      if (path === '/repos/acme/site/hooks') {
        return req.method === 'GET'
          ? Response.json([])
          : Response.json({ id: 1, config: { url: 'x' } }, { status: 201 });
      }
      if (path === '/repos/acme/site/pulls' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;
        if (state.pullStatus !== 201) {
          return Response.json({ message: state.pullMessage }, { status: state.pullStatus });
        }
        pulls.push(body);
        return Response.json(
          {
            number: 12,
            title: body.title,
            body: body.body,
            state: 'open',
            draft: false,
            html_url: 'https://github.com/acme/site/pull/12',
            head: { ref: body.head, sha: 'abc' },
            base: { ref: body.base },
            updated_at: new Date().toISOString(),
          },
          { status: 201 },
        );
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    pulls,
    state,
    stop: () => server.stop(true),
  };
}

async function setup(fake: ReturnType<typeof fakeGithub>, synced = true) {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  const created = await createProject(asOwner, { key: 'ABC', name: 'Project' });
  const teamId = created.data!.teamId;
  const connection = await asOwner
    .teams({ teamId })
    .settings.git.connections.post({ provider: 'github', baseUrl: fake.baseUrl, token: 't-1' });
  const connectionId = connection.data!.id;
  const connected = await asOwner
    .projects({ projectKey: 'ABC' })
    .settings.git.connections({ connectionId })
    .repositories.post({ externalIds: ['1'] });
  const repositoryId = connected.data!.repositories[0]!.id;
  const view = (await asOwner.projects({ projectKey: 'ABC' }).get()).data!;
  const agent = (
    await createAgent(asOwner, 'ABC', {
      name: 'Ext Bot',
      username: 'ext',
      kind: 'external',
      triggerOnAssign: true,
      delegationDelaySec: 0,
    })
  ).data!;
  const issue = (
    await asOwner.projects({ projectKey: 'ABC' }).issues.post({
      title: 'Fix the login: now!',
      columnId: view.columns[0]!.id,
    })
  ).data!;
  if (synced) {
    // The link is written by the sync, which needs a full provider; the claim reads only
    // the row.
    await db.insert(issueSyncLink).values({
      issueId: issue.id,
      managedRepositoryId: repositoryId,
      externalId: '9001',
      externalNumber: 7,
      externalUrl: 'https://github.com/acme/site/issues/7',
      syncedHash: 'x',
      externalUpdatedAt: new Date(),
    });
  }
  await asOwner.issues({ issueId: issue.id }).patch({ delegateUserId: agent.agent.userId });
  return { asOwner, issue, asRunner: apiKeyApi(agent.apiKey!) };
}

describe('agent clones the linked repository and opens a pull request', () => {
  const environment = { ...process.env };
  let fake: ReturnType<typeof fakeGithub>;

  beforeEach(async () => {
    await resetDb();
    process.env.NODE_ENV = 'development';
    fake = fakeGithub();
  });

  afterEach(() => {
    fake.stop();
    process.env.NODE_ENV = environment.NODE_ENV;
  });

  it('hands the repository, base branch and branch name to the runner', async () => {
    const { asRunner, issue } = await setup(fake);

    const claimed = await asRunner['agent-runs'].claim.post();

    expect(claimed.data!.run).toMatchObject({
      trigger: 'delegation',
      repository: {
        url: 'https://github.com/acme/site.git',
        baseBranch: 'trunk',
        branch: `abc-${issue.sequenceNumber}-fix-the-login-now`,
      },
    });
  });

  it('sends no repository for an issue that is not synced', async () => {
    const { asRunner } = await setup(fake, false);

    const claimed = await asRunner['agent-runs'].claim.post();

    expect(claimed.data!.run).toMatchObject({ trigger: 'delegation', repository: null });
  });

  it('opens a pull request that closes the GitHub issue and links it', async () => {
    const { asRunner, asOwner, issue } = await setup(fake);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    const reported = await asRunner['agent-runs']({ runId: run.id }).result.post({
      status: 'success',
      branch: run.repository!.branch,
    });

    expect(reported.status).toBe(204);
    expect(fake.pulls).toMatchObject([
      { head: run.repository!.branch, base: 'trunk', body: 'Closes #7', title: issue.title },
    ]);
    const detail = (await asOwner.issues({ issueId: issue.id }).get()).data!;
    expect(detail.development).toMatchObject([
      { kind: 'pull_request', number: 12, repository: 'acme/site' },
    ]);
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    expect(row).toMatchObject({ status: 'success' });
  });

  it('opens no pull request from a branch other than the one of the run', async () => {
    const { asRunner } = await setup(fake);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    await asRunner['agent-runs']({ runId: run.id }).result.post({
      status: 'success',
      branch: 'main',
    });

    expect(fake.pulls).toHaveLength(0);
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    expect(row).toMatchObject({
      status: 'failed',
      lastError: 'The reported branch is not the branch of this run',
    });
  });

  it('fails the run when GitHub refuses the pull request', async () => {
    const { asRunner } = await setup(fake);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;
    fake.state.pullStatus = 422;
    fake.state.pullMessage = 'Validation Failed';

    await asRunner['agent-runs']({ runId: run.id }).result.post({
      status: 'success',
      branch: run.repository!.branch,
    });

    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.lastError).toContain('Could not open the pull request');
  });

  it('opens no second pull request for a branch that has an open one', async () => {
    const { asRunner } = await setup(fake);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;
    const result = { status: 'success' as const, branch: run.repository!.branch };
    await asRunner['agent-runs']({ runId: run.id }).result.post(result);
    // A second delegation reports the same branch; the run is made pending again here.
    await db.update(agentRun).set({ status: 'pending' }).where(eq(agentRun.id, run.id));

    await asRunner['agent-runs']({ runId: run.id }).result.post(result);

    expect(fake.pulls).toHaveLength(1);
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    expect(row).toMatchObject({ status: 'success' });
  });

  it('keeps a run without a branch as a plain success', async () => {
    const { asRunner } = await setup(fake);
    const run = (await asRunner['agent-runs'].claim.post()).data!.run!;

    await asRunner['agent-runs']({ runId: run.id }).result.post({ status: 'success' });

    expect(fake.pulls).toHaveLength(0);
    const [row] = await db.select().from(agentRun).where(eq(agentRun.id, run.id));
    expect(row).toMatchObject({ status: 'success' });
  });
});

describe('branchName', () => {
  it('joins the lowercased issue key and a slug of the title', () => {
    expect(branchName('ABC-123', 'Fix the Login Bug!')).toBe('abc-123-fix-the-login-bug');
  });

  it('cuts a long title without a trailing dash', () => {
    const name = branchName('ABC-1', 'a'.repeat(39) + ' bcd');
    expect(name).toBe(`abc-1-${'a'.repeat(39)}`);
  });

  it('is the key alone when the title has no letters or digits', () => {
    expect(branchName('ABC-1', '???')).toBe('abc-1');
  });
});
