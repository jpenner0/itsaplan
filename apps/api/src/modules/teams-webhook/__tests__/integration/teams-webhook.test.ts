import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { db, notificationDelivery, userTeamsWebhook } from '@repo/db';
import { asc, eq } from 'drizzle-orm';
import { readTeamsWebhookUrl } from '@repo/db';
import * as realTeams from '@repo/net/teams-webhook';
import { authedApi, createProject, type Api } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// Microsoft does not offer a test tenant, so the post to Teams is replaced by a
// recorder. The URL checks, the encryption and the queueing are real.

const URL_OK =
  'https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRET';
let reply: realTeams.TeamsPostResult = { ok: true };
const posts: { url: string; card: realTeams.TeamsCard }[] = [];
void mock.module('@repo/net/teams-webhook', () => ({
  ...realTeams,
  postTeamsCard: async (url: string, card: realTeams.TeamsCard) => {
    posts.push({ url, card });
    return reply;
  },
}));
afterAll(() => {
  void mock.module('@repo/net/teams-webhook', () => realTeams);
});

const events = { assigned: true, mentioned: true, commented: true, state_changed: true };

async function setup() {
  const owner = await signUpTestUser();
  const api = authedApi(owner.cookie);
  await createProject(api, { key: 'MKT', name: 'Marketing' });
  const view = await api.projects({ projectKey: 'MKT' }).get();
  const member = await signUpTestUser();
  const invite = await api
    .projects({ projectKey: 'MKT' })
    .invites.post({ email: member.email, role: 'member' });
  const memberApi = authedApi(member.cookie);
  await memberApi.invites({ token: invite.data!.token }).accept.post();
  return {
    api,
    memberApi,
    member,
    teamId: view.data!.project.teamId,
    columnId: view.data!.columns[0].id,
  };
}

async function enableTeams(api: Api, teamId: number) {
  return api.teams({ teamId })['notification-settings'].put({ teams: { enabled: true } });
}

function assign(api: Api, columnId: number, userId: string) {
  return api
    .projects({ projectKey: 'MKT' })
    .issues.post({ columnId, title: 'Task', assigneeUserId: userId });
}

describe('teams webhook connection', () => {
  beforeEach(async () => {
    await resetDb();
    posts.length = 0;
    reply = { ok: true };
  });

  it('stores the url encrypted after a test card and returns only the host', async () => {
    const { memberApi, member } = await setup();
    const res = await memberApi['teams-webhook'].put({ url: URL_OK });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      connected: true,
      host: 'prod-12.westus.logic.azure.com',
      broken: false,
      lastError: null,
    });
    expect(JSON.stringify(res.data)).not.toContain('SECRET');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.card.title).toBe("It's a Plan is connected");
    const [row] = await db.select().from(userTeamsWebhook);
    expect(JSON.stringify(row)).not.toContain('SECRET');
    expect(await readTeamsWebhookUrl(member.userId)).toBe(URL_OK);
    expect((await memberApi['teams-webhook'].get()).data!.connected).toBe(true);
  });

  it.each(['http://prod-1.logic.azure.com/x', 'https://example.com/x', 'nope'])(
    'refuses %s without posting',
    async (url) => {
      const { memberApi } = await setup();
      const res = await memberApi['teams-webhook'].put({ url });
      expect(res.status).toBe(400);
      expect(posts).toHaveLength(0);
      expect((await memberApi['teams-webhook'].get()).data!.connected).toBe(false);
    },
  );

  it('does not store the url when Teams refuses the test card', async () => {
    const { memberApi } = await setup();
    reply = { ok: false, retryable: false, error: 'Teams HTTP 401' };
    const res = await memberApi['teams-webhook'].put({ url: URL_OK });
    expect(res.status).toBe(400);
    expect((await memberApi['teams-webhook'].get()).data!.connected).toBe(false);
  });

  it('disconnect deletes the row and keeps the Teams toggles', async () => {
    const { memberApi } = await setup();
    await memberApi['teams-webhook'].put({ url: URL_OK });
    await memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].put({
      emailEvents: events,
      telegramEvents: events,
      teamsEvents: events,
    });
    expect((await memberApi['teams-webhook'].delete()).status).toBe(204);
    expect((await memberApi['teams-webhook'].get()).data!.connected).toBe(false);
    const prefs = await memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].get();
    expect(prefs.data!.teamsEvents).toEqual(events);
  });

  it('saving again clears a broken connection', async () => {
    const { memberApi, member } = await setup();
    await memberApi['teams-webhook'].put({ url: URL_OK });
    await db
      .update(userTeamsWebhook)
      .set({ brokenAt: new Date(), lastError: 'Teams HTTP 404' })
      .where(eq(userTeamsWebhook.userId, member.userId));
    expect((await memberApi['teams-webhook'].get()).data).toMatchObject({
      broken: true,
      lastError: 'Teams HTTP 404',
    });
    const res = await memberApi['teams-webhook'].put({ url: URL_OK });
    expect(res.data).toMatchObject({ broken: false, lastError: null });
  });
});

describe('teams delivery enqueue', () => {
  beforeEach(async () => {
    await resetDb();
    posts.length = 0;
    reply = { ok: true };
  });

  async function connect(api: Api, projectOptIn = true) {
    await api['teams-webhook'].put({ url: URL_OK });
    if (projectOptIn) {
      await api.projects({ projectKey: 'MKT' })['notification-preferences'].put({
        emailEvents: { ...events, assigned: false },
        telegramEvents: { ...events, assigned: false },
        teamsEvents: events,
      });
    }
  }

  async function queued() {
    return db.select().from(notificationDelivery).orderBy(asc(notificationDelivery.id));
  }

  it('queues a Teams row with the email copy once the team enabled Teams', async () => {
    const { api, memberApi, member, teamId, columnId } = await setup();
    await enableTeams(api, teamId);
    await connect(memberApi);
    await assign(api, columnId, member.userId);
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'teams', recipient: member.userId });
    expect(rows[0]!.payload.subject).toMatch(/^MKT-\d+: assigned to you$/);
    expect(rows[0]!.payload.url).toContain('/issue/MKT-');
  });

  it('queues nothing while the team gate is off', async () => {
    const { api, memberApi, member, columnId } = await setup();
    await connect(memberApi);
    await assign(api, columnId, member.userId);
    expect(await queued()).toHaveLength(0);
  });

  it('queues nothing without a webhook, for an event not opted into, or while broken', async () => {
    const { api, memberApi, member, teamId, columnId } = await setup();
    await enableTeams(api, teamId);
    await memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].put({
      emailEvents: events,
      telegramEvents: events,
      teamsEvents: { ...events, assigned: false },
    });
    await assign(api, columnId, member.userId);
    expect(await queued()).toHaveLength(0);

    await connect(memberApi, false);
    await memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].put({
      emailEvents: events,
      telegramEvents: events,
      teamsEvents: { ...events, assigned: false },
    });
    await assign(api, columnId, member.userId);
    expect(await queued()).toHaveLength(0);

    await memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].put({
      emailEvents: events,
      telegramEvents: events,
      teamsEvents: events,
    });
    await db.update(userTeamsWebhook).set({ brokenAt: new Date() });
    await assign(api, columnId, member.userId);
    expect(await queued()).toHaveLength(0);
  });

  it('shows the team gate to members in their preferences', async () => {
    const { api, memberApi, teamId } = await setup();
    const read = () => memberApi.projects({ projectKey: 'MKT' })['notification-preferences'].get();
    expect((await read()).data!.teamsEnabled).toBe(false);
    await enableTeams(api, teamId);
    expect((await read()).data!.teamsEnabled).toBe(true);
  });

  it('only the team owner can turn Teams on', async () => {
    const { memberApi, teamId } = await setup();
    expect((await enableTeams(memberApi, teamId)).status).toBe(403);
  });
});
