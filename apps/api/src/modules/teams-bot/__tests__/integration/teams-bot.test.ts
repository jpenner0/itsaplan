import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { db, notificationDelivery, userTeamsBotAccount } from '@repo/db';
import * as realBot from '@repo/net/teams-bot';
import { app, authedApi, createProject, ownWorkspaceId, type Api } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// Microsoft offers no test tenant. The signing keys are a local pair and the replies the
// bot sends are recorded. The token checks, the linking and the queueing are real.

const APP_ID = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
void mock.module('../../jwks', () => ({ botFrameworkKeys: createLocalJWKSet({ keys: [jwk] }) }));

const replies: string[] = [];
void mock.module('@repo/net/teams-bot', () => ({
  ...realBot,
  sendBotText: async (_conversation: unknown, text: string) => {
    replies.push(text);
    return { ok: true };
  },
}));

const saved = { ...process.env };
beforeAll(() => {
  process.env.TEAMS_BOT_APP_ID = APP_ID;
  process.env.TEAMS_BOT_APP_PASSWORD = 'secret';
  process.env.TEAMS_BOT_TENANT_ID = TENANT;
});
afterAll(() => {
  for (const key of ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  void mock.module('@repo/net/teams-bot', () => realBot);
});

async function token(over: { aud?: string; serviceurl?: string; iss?: string } = {}) {
  return new SignJWT({ serviceurl: over.serviceurl ?? SERVICE_URL })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(over.iss ?? 'https://api.botframework.com')
    .setAudience(over.aud ?? APP_ID)
    .setExpirationTime('5m')
    .sign(privateKey);
}

function activity(text: string, over: Record<string, unknown> = {}) {
  return {
    type: 'message',
    text,
    serviceUrl: SERVICE_URL,
    from: { id: '29:teams-user-1', name: 'Pat Teams' },
    conversation: { id: 'a:conv-1', conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    ...over,
  };
}

async function post(body: object, bearer: string | null) {
  return app.handle(
    new Request('http://localhost/teams-bot/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function startLink(api: Api) {
  return (await api['teams-bot'].account.link.post()).data!;
}

describe('teams bot', () => {
  beforeEach(async () => {
    await resetDb();
    replies.length = 0;
  });

  it('links an account when the code arrives in a personal chat', async () => {
    const user = await signUpTestUser();
    const api = authedApi(user.cookie);
    const start = await startLink(api);
    expect(start.chatUrl).toContain(`28:${APP_ID}`);

    const res = await post(activity(`link ${start.code}`), await token());
    expect(res.status).toBe(200);
    expect(replies).toEqual(['Your Teams account is connected. Notifications will arrive here.']);
    const view = (await api['teams-bot'].account.get()).data!;
    expect(view.available).toBe(true);
    expect(view.link).toMatchObject({ displayName: 'Pat Teams', broken: false });
    const [row] = await db.select().from(userTeamsBotAccount);
    expect(row).toMatchObject({
      serviceUrl: SERVICE_URL,
      conversationId: 'a:conv-1',
      linkCode: null,
    });
  });

  it('refuses requests without a valid Microsoft token', async () => {
    const bad = [
      null,
      await token({ aud: 'someone-else' }),
      await token({ iss: 'https://evil.example.com' }),
      await token({ serviceurl: 'https://evil.example.com/' }),
    ];
    for (const bearer of bad) {
      expect((await post(activity('hello'), bearer)).status).toBe(401);
    }
    expect(replies).toHaveLength(0);
  });

  it('does not link from a group chat or another tenant', async () => {
    const user = await signUpTestUser();
    const api = authedApi(user.cookie);
    const { code } = await startLink(api);

    await post(
      activity(`link ${code}`, { conversation: { id: 'c', conversationType: 'groupChat' } }),
      await token(),
    );
    expect(replies).toEqual(['Open a private chat with this bot to connect your account.']);

    replies.length = 0;
    await post(
      activity(`link ${code}`, { channelData: { tenant: { id: 'other' } } }),
      await token(),
    );
    expect(replies).toHaveLength(0);
    expect((await api['teams-bot'].account.get()).data!.link).toBeNull();
  });

  it('refuses an expired or unknown code and one Teams account for two users', async () => {
    const first = authedApi((await signUpTestUser()).cookie);
    const second = authedApi((await signUpTestUser()).cookie);

    await post(activity('link 000000000000'), await token());
    expect(replies.pop()).toContain('expired');

    const a = await startLink(first);
    await post(activity(`link ${a.code}`), await token());
    const b = await startLink(second);
    await post(activity(`link ${b.code}`), await token());
    expect(replies.pop()).toBe('This Teams account is already connected to another user.');
    expect((await second['teams-bot'].account.get()).data!.link).toBeNull();
  });

  it('answers anything else with help, and disconnect deletes the link', async () => {
    const api = authedApi((await signUpTestUser()).cookie);
    const { code } = await startLink(api);
    await post(activity('hello'), await token());
    expect(replies.pop()).toContain('link <code>');
    await post(activity(`link ${code}`), await token());
    expect((await api['teams-bot'].account.delete()).status).toBe(204);
    expect((await api['teams-bot'].account.get()).data!.link).toBeNull();
  });

  it('is not offered without the bot credentials', async () => {
    const api = authedApi((await signUpTestUser()).cookie);
    delete process.env.TEAMS_BOT_APP_ID;
    try {
      expect((await api['teams-bot'].account.get()).data).toMatchObject({
        available: false,
        chatUrl: null,
      });
      expect((await api['teams-bot'].account.link.post()).status).toBe(400);
      expect((await post(activity('hello'), await token())).status).toBe(404);
    } finally {
      process.env.TEAMS_BOT_APP_ID = APP_ID;
    }
  });

  it('queues Teams notifications for a linked member who has no webhook', async () => {
    const owner = authedApi((await signUpTestUser()).cookie);
    await createProject(owner, { key: 'MKT', name: 'Marketing' });
    const view = await owner.projects({ projectKey: 'MKT' }).get();
    const member = await signUpTestUser();
    const memberApi = authedApi(member.cookie);
    const invite = await owner
      .projects({ projectKey: 'MKT' })
      .invites.post({ email: member.email, role: 'member' });
    await memberApi.invites({ token: invite.data!.token }).accept.post();
    await owner
      .teams({ teamId: view.data!.project.teamId })
      ['notification-settings'].put({ teams: { enabled: true } });
    const events = { assigned: true, mentioned: true, commented: true, state_changed: true };
    await memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].put({
      emailEvents: events,
      telegramEvents: events,
      teamsEvents: events,
    });
    const columnId = view.data!.columns[0].id;
    const assign = () =>
      owner
        .projects({ projectKey: 'MKT' })
        .issues.post({ columnId, title: 'Task', assigneeUserId: member.userId });

    await assign();
    expect(await db.select().from(notificationDelivery)).toHaveLength(0);

    const { code } = await startLink(memberApi);
    await post(activity(`link ${code}`), await token());
    await assign();
    const rows = await db.select().from(notificationDelivery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'teams', recipient: member.userId });

    await db.update(userTeamsBotAccount).set({ brokenAt: new Date() });
    await assign();
    expect(await db.select().from(notificationDelivery)).toHaveLength(1);
  });
});

describe('teams bot commands', () => {
  const WEB = 'https://plan.example.com';
  let api: Api;
  let me: { userId: string };
  let columns: { id: number; stateType: string }[];

  async function ask(text: string, over: Record<string, unknown> = {}) {
    replies.length = 0;
    expect((await post(activity(text, over), await token())).status).toBe(200);
    return replies.join('\n');
  }

  async function addIssue(client: Api, key: string, title: string, body: object = {}) {
    const view = await client.projects({ projectKey: key }).get();
    const created = await client
      .projects({ projectKey: key })
      .issues.post({ columnId: view.data!.columns[0].id, title, ...body });
    return created.data!;
  }

  beforeEach(async () => {
    process.env.APP_URL = WEB;
    await resetDb();
    replies.length = 0;
    const user = await signUpTestUser();
    me = user;
    api = authedApi(user.cookie);
    await createProject(api, { key: 'MKT', name: 'Marketing' });
    columns = (await api.projects({ projectKey: 'MKT' }).get()).data!.columns;
    const { code } = await startLink(api);
    await post(activity(`link ${code}`), await token());
  });

  afterAll(() => {
    if (saved.APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved.APP_URL;
  });

  it('lists the commands for help and for an unknown keyword', async () => {
    for (const text of ['help', 'HELP', 'bogus words']) {
      const reply = await ask(text);
      for (const word of ['my', 'search <text>', 'show <id>', 'link <code>']) {
        expect(reply).toContain(word);
      }
    }
  });

  it('asks an unlinked Teams account to connect first', async () => {
    const reply = await ask('my', { from: { id: '29:stranger', name: 'Sam' } });
    expect(reply).toContain('Connect your account first');
  });

  it('answers only in a personal chat', async () => {
    const reply = await ask('my', { conversation: { id: 'g', conversationType: 'groupChat' } });
    expect(reply).toBe('Open a private chat with this bot to connect your account.');
  });

  it('my lists the open issues assigned to me, latest change first, at most 10', async () => {
    const done = columns.find((c) => c.stateType === 'completed')!;
    const closed = await addIssue(api, 'MKT', 'Closed one', { assigneeUserId: me.userId });
    await api.issues({ issueId: closed.id }).patch({ columnId: done.id });
    await addIssue(api, 'MKT', 'Not mine');
    expect(await ask('my')).toBe('No open issues are assigned to you.');

    const first = await addIssue(api, 'MKT', 'First task', { assigneeUserId: me.userId });
    await addIssue(api, 'MKT', 'Second task', { assigneeUserId: me.userId });
    const reply = await ask('my');
    expect(reply).not.toContain('Closed one');
    expect(reply).not.toContain('Not mine');
    expect(reply.indexOf('Second task')).toBeLessThan(reply.indexOf('First task'));
    expect(reply).toContain(`${WEB}/`);
    expect(reply).toContain(first.identifier);

    for (let i = 0; i < 11; i++)
      await addIssue(api, 'MKT', `Bulk ${i}`, { assigneeUserId: me.userId });
    expect((await ask('my')).split('\n\n')).toHaveLength(10);
  });

  it('search finds issues across my projects and skips archived ones', async () => {
    await createProject(api, { key: 'OPS', name: 'Operations' });
    const a = await addIssue(api, 'MKT', 'Launch banner');
    await addIssue(api, 'OPS', 'Launch checklist');
    await addIssue(api, 'OPS', 'Unrelated');
    const archived = await addIssue(api, 'OPS', 'Launch retired');
    await api.issues({ issueId: archived.id }).archive.post();

    const reply = await ask('search launch');
    expect(reply).toContain('Launch banner');
    expect(reply).toContain('Launch checklist');
    expect(reply).not.toContain('Unrelated');
    expect(reply).not.toContain('Launch retired');
    expect(reply).toContain(a.identifier);
    for (let i = 0; i < 11; i++) {
      const old = await addIssue(api, 'OPS', `Launch old ${i}`);
      await api.issues({ issueId: old.id }).archive.post();
    }
    expect(await ask('search launch')).toContain('Launch banner');
    expect(await ask('search old')).toBe('No issues found.');
    expect(await ask('search zzz-nothing')).toBe('No issues found.');
    expect(await ask('search')).toBe('Usage: search <text>');
  });

  it('show gives title, status, assignee, a shortened description and the link', async () => {
    const issue = await addIssue(api, 'MKT', 'Write copy', {
      assigneeUserId: me.userId,
      description: 'x'.repeat(500),
    });
    const reply = await ask(`show ${issue.identifier.toLowerCase()}`);
    expect(reply).toContain(`${issue.identifier} Write copy`);
    expect(reply).toContain('Status: Backlog');
    expect(reply).toMatch(/Assignee: Test User \d+/);
    expect(reply).toContain('x'.repeat(300) + '…');
    expect(reply).not.toContain('x'.repeat(301));
    expect(reply).toContain(`/issue/${issue.identifier}`);
    expect(await ask('show MKT-9999')).toBe('Not found.');
    expect(await ask('show nonsense')).toContain('Usage: show <id>');
  });

  it('gives one not-found reply for an inaccessible project and a missing issue', async () => {
    const other = authedApi((await signUpTestUser()).cookie);
    await createProject(other, { key: 'SEC', name: 'Secret' });
    const secret = await addIssue(other, 'SEC', 'Hidden plan');

    expect(await ask(`show ${secret.identifier}`)).toBe('Not found.');
    expect(await ask('show MKT-9999')).toBe('Not found.');
    expect(await ask('search hidden')).toBe('No issues found.');
  });

  it('lists the projects when a key is ambiguous and accepts the team-qualified form', async () => {
    const team = await api.teams.post({
      name: 'Design',
      slug: 'design',
      workspaceId: await ownWorkspaceId(api),
    });
    await api.teams({ teamId: team.data!.id }).projects.post({ key: 'MKT', name: 'Design site' });
    const view = await api.teams({ teamId: team.data!.id }).projects.get();
    expect(view.status).toBe(200);
    const designView = await api.projects({ projectKey: 'design.MKT' }).get();
    const created = await api
      .projects({ projectKey: 'design.MKT' })
      .issues.post({ columnId: designView.data!.columns[0].id, title: 'Design task' });
    expect(created.status).toBe(201);

    const reply = await ask('show MKT-1');
    expect(reply).toContain('Several projects match');
    expect(reply).toContain('@design/MKT-1 (Design site');
    expect(reply).toContain('Marketing');
    expect(reply).not.toContain('Design task');

    expect(await ask('show @design/mkt-1')).toContain('Design task');
  });
});
