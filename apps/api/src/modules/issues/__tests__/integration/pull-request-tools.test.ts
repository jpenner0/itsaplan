import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { db, issueDevelopmentLink } from '@repo/db';
import { authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { addProjectMember } from '#tests/helpers/members';
import { createRole } from '#tests/helpers/roles';
import { PULL_REQUEST_DIFF_MAX_BYTES } from '#modules/git/connections-service';

// Reading the diff of a pull request linked to an issue and commenting on it, against a
// GitHub served on localhost. The SSRF guard refuses http and loopback hosts under
// NODE_ENV=test, so each case runs as development.

const DIFF = 'diff --git a/README.md b/README.md\n+Hello\n';

interface Received {
  method: string;
  path: string;
  accept: string | null;
  authorization: string | null;
  body: unknown;
}

function fakeGitHub() {
  const received: Received[] = [];
  const state = { diff: DIFF, diffStatus: 200 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/api\/v3/, '');
      const accept = req.headers.get('accept');
      received.push({
        method: req.method,
        path,
        accept,
        authorization: req.headers.get('authorization'),
        body: req.method === 'POST' ? await req.json() : null,
      });
      if (path === '/user') return Response.json({ login: 'octo' });
      if (path === '/repositories/1') {
        return Response.json({
          id: 1,
          full_name: 'acme/site',
          html_url: 'https://github.example/acme/site',
          permissions: { admin: true },
        });
      }
      if (path === '/repos/acme/site/hooks') {
        return req.method === 'GET'
          ? Response.json([])
          : Response.json({ id: 1, config: { url: 'x' } }, { status: 201 });
      }
      if (path === '/repos/acme/site/pulls/7') {
        if (accept === 'application/vnd.github.diff') {
          return new Response(state.diff, { status: state.diffStatus });
        }
        return Response.json({
          number: 7,
          title: 'Add greeting',
          html_url: 'https://github.example/acme/site/pull/7',
          state: 'open',
          base: { ref: 'main' },
          head: { ref: 'greeting', sha: 'abc123' },
          updated_at: '2026-01-01T00:00:00Z',
        });
      }
      if (path === '/repos/acme/site/actions/runs') return Response.json({ workflow_runs: [] });
      if (path === '/repos/acme/site/issues/7/comments' && req.method === 'POST') {
        return Response.json({ id: 1 }, { status: 201 });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    received,
    state,
    stop: () => server.stop(true),
  };
}

type Fake = ReturnType<typeof fakeGitHub>;

async function createIssue(client: Api, projectKey: string, title = 'Task') {
  const view = await client.projects({ projectKey }).get();
  const created = await client
    .projects({ projectKey })
    .issues.post({ columnId: view.data!.columns[0].id, title });
  return created.data!.id;
}

// A project MKT that manages acme/site through the team's GitHub connection, with
// pull request #7 linked to one of its issues.
async function setup(fake: Fake) {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  const created = await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  const connection = await asOwner
    .teams({ teamId: created.data!.teamId })
    .settings.git.connections.post({ provider: 'github', baseUrl: fake.baseUrl, token: 'tok-1' });
  expect(connection.status).toBe(201);
  const connected = await asOwner
    .projects({ projectKey: 'MKT' })
    .settings.git.connections({ connectionId: connection.data!.id })
    .repositories.post({ externalIds: ['1'] });
  expect(connected.status).toBe(200);
  const repositoryId = connected.data!.repositories[0]!.id;
  const issueId = await createIssue(asOwner, 'MKT');
  const linked = await asOwner.issues({ issueId }).development.post({ repositoryId, number: 7 });
  expect(linked.status).toBe(201);
  return { owner, asOwner, issueId, linkId: linked.data!.id };
}

function diffOf(client: Api, issueId: number, linkId: number) {
  return client.issues({ issueId }).development({ linkId }).diff.get();
}

function comment(client: Api, issueId: number, linkId: number, body: string) {
  return client.issues({ issueId }).development({ linkId }).comments.post({ body });
}

async function insertLink(issueId: number, values: { provider: string; repository: string }) {
  const [row] = await db
    .insert(issueDevelopmentLink)
    .values({
      issueId,
      ...values,
      kind: 'pull_request',
      externalKey: `${values.repository}#7`,
      number: 7,
      title: 'Elsewhere',
      state: 'open',
      targetBranch: 'main',
    })
    .returning({ id: issueDevelopmentLink.id });
  return row!.id;
}

describe('Pull request tools of an issue', () => {
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

  describe('GET /issues/:issueId/development/:linkId/diff', () => {
    it('returns the diff of the linked pull request, read with the team token', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        repository: 'acme/site',
        number: 7,
        url: 'https://github.example/acme/site/pull/7',
        diff: DIFF,
        truncated: false,
      });
      expect(JSON.stringify(res.data)).not.toContain('tok-1');
      expect(fake.received.at(-1)).toMatchObject({
        method: 'GET',
        path: '/repos/acme/site/pulls/7',
        accept: 'application/vnd.github.diff',
        authorization: 'Bearer tok-1',
      });
    });

    it('is open to a member who can read the issue', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);
      const member = await addProjectMember(asOwner, 'MKT');

      expect((await diffOf(member, issueId, linkId)).status).toBe(200);
    });

    it('returns a diff of exactly the limit whole', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);
      fake.state.diff = 'a'.repeat(PULL_REQUEST_DIFF_MAX_BYTES);

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.data).toMatchObject({ truncated: false });
      expect(res.data!.diff.length).toBe(PULL_REQUEST_DIFF_MAX_BYTES);
    });

    it('cuts a diff over the limit and says so', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);
      fake.state.diff = 'a'.repeat(PULL_REQUEST_DIFF_MAX_BYTES + 5000);

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ truncated: true });
      expect(res.data!.diff.length).toBe(PULL_REQUEST_DIFF_MAX_BYTES);
    });

    it('drops a multi-byte character cut at the limit', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);
      fake.state.diff = `${'a'.repeat(PULL_REQUEST_DIFF_MAX_BYTES - 1)}é and more`;

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.data!.diff).toBe('a'.repeat(PULL_REQUEST_DIFF_MAX_BYTES - 1));
    });

    it('explains a diff GitHub refuses as too large', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);
      fake.state.diffStatus = 406;

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.status).toBe(400);
      expect(res.error?.value).toMatchObject({
        error: 'GitHub does not return a diff for a pull request this large',
      });
    });

    it('is a 404 for a link of another issue', async () => {
      const { asOwner, linkId } = await setup(fake);
      const otherIssueId = await createIssue(asOwner, 'MKT', 'Other');

      expect((await diffOf(asOwner, otherIssueId, linkId)).status).toBe(404);
    });

    it("is a 404 for a link of another project's issue", async () => {
      const { asOwner, issueId } = await setup(fake);
      await createProject(asOwner, { key: 'OPS', name: 'Operations' });
      const opsIssueId = await createIssue(asOwner, 'OPS');
      const opsLinkId = await insertLink(opsIssueId, {
        provider: 'github',
        repository: 'acme/site',
      });

      expect((await diffOf(asOwner, issueId, opsLinkId)).status).toBe(404);
      // OPS manages no repository, so its own link reaches nothing either.
      expect((await diffOf(asOwner, opsIssueId, opsLinkId)).status).toBe(404);
    });

    it('is a 404 for a pull request in a repository the project does not manage', async () => {
      const { asOwner, issueId } = await setup(fake);
      const linkId = await insertLink(issueId, { provider: 'github', repository: 'acme/other' });

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.status).toBe(404);
      expect(fake.received.some((r) => r.path.startsWith('/repos/acme/other'))).toBe(false);
    });

    it('refuses a pull request outside GitHub', async () => {
      const { asOwner, issueId } = await setup(fake);
      const linkId = await insertLink(issueId, { provider: 'gitlab', repository: 'acme/site' });

      const res = await diffOf(asOwner, issueId, linkId);

      expect(res.status).toBe(400);
      expect(res.error?.value).toMatchObject({
        error: 'Reading and commenting on pull requests supports GitHub only',
      });
    });

    it('rejects a non-member', async () => {
      const { issueId, linkId } = await setup(fake);
      const outsider = await signUpTestUser();

      expect((await diffOf(authedApi(outsider.cookie), issueId, linkId)).status).toBe(403);
    });
  });

  describe('POST /issues/:issueId/development/:linkId/comments', () => {
    it('posts the comment under a line that names its author', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);

      const res = await comment(asOwner, issueId, linkId, '  Looks good.  ');

      expect(res.status).toBe(201);
      expect(res.data).toEqual({
        repository: 'acme/site',
        number: 7,
        url: 'https://github.example/acme/site/pull/7',
      });
      expect(fake.received.at(-1)).toEqual({
        method: 'POST',
        path: '/repos/acme/site/issues/7/comments',
        accept: 'application/vnd.github+json',
        authorization: 'Bearer tok-1',
        body: { body: "**Owner** (via It's a Plan):\n\nLooks good." },
      });
    });

    it('accepts a comment of the maximum length and refuses a longer one', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);

      expect((await comment(asOwner, issueId, linkId, 'a'.repeat(60_000))).status).toBe(201);
      expect((await comment(asOwner, issueId, linkId, 'a'.repeat(60_001))).status).toBe(400);
    });

    it('refuses an empty comment', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);

      expect((await comment(asOwner, issueId, linkId, '   ')).status).toBe(400);
      expect((await comment(asOwner, issueId, linkId, '')).status).toBe(400);
      expect(fake.received.some((r) => r.path.endsWith('/comments'))).toBe(false);
    });

    it('is a 404 for a link of another issue', async () => {
      const { asOwner, linkId } = await setup(fake);
      const otherIssueId = await createIssue(asOwner, 'MKT', 'Other');

      expect((await comment(asOwner, otherIssueId, linkId, 'Hi')).status).toBe(404);
      expect(fake.received.some((r) => r.path.endsWith('/comments'))).toBe(false);
    });

    it('refuses a pull request outside GitHub', async () => {
      const { asOwner, issueId } = await setup(fake);
      const linkId = await insertLink(issueId, { provider: 'gitlab', repository: 'acme/site' });

      expect((await comment(asOwner, issueId, linkId, 'Hi')).status).toBe(400);
    });

    it('refuses a member who may only read the issue', async () => {
      const { asOwner, issueId, linkId } = await setup(fake);
      const role = await createRole(asOwner, 'MKT', {
        name: 'Reader',
        permissions: { work_items: { read: true } },
      });
      const reader = await addProjectMember(asOwner, 'MKT', role.data!.id);

      expect((await diffOf(reader, issueId, linkId)).status).toBe(200);
      expect((await comment(reader, issueId, linkId, 'Hi')).status).toBe(403);
    });

    it('rejects a non-member', async () => {
      const { issueId, linkId } = await setup(fake);
      const outsider = await signUpTestUser();

      expect((await comment(authedApi(outsider.cookie), issueId, linkId, 'Hi')).status).toBe(403);
    });
  });
});
