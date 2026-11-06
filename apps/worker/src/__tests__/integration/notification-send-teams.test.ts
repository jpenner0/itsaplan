import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  appSecret,
  db,
  project,
  team,
  teamNotificationSetting,
  user,
  userTeamsBotAccount,
  userTeamsWebhook,
  workspace,
} from '@repo/db';
import { encryptSecret } from '@repo/crypto';
import { eq } from 'drizzle-orm';
import * as realTeams from '@repo/net/teams-webhook';
import * as realBot from '@repo/net/teams-bot';
import { deliverNotification } from '../../notification-send';

// Microsoft offers no test tenant, so the post is replaced by a recorder. The webhook
// row, its decryption and the broken marker are real.

let reply: realTeams.TeamsPostResult = { ok: true };
const posts: { url: string; card: realTeams.TeamsCard }[] = [];
void mock.module('@repo/net/teams-webhook', () => ({
  ...realTeams,
  postTeamsCard: async (url: string, card: realTeams.TeamsCard) => {
    posts.push({ url, card });
    return reply;
  },
}));

let botReply: realBot.TeamsBotSendResult = { ok: true };
const botSent: { conversation: realBot.TeamsBotConversation; card: realTeams.TeamsCard }[] = [];
void mock.module('@repo/net/teams-bot', () => ({
  ...realBot,
  sendBotCard: async (conversation: realBot.TeamsBotConversation, card: realTeams.TeamsCard) => {
    botSent.push({ conversation, card });
    return botReply;
  },
}));
afterAll(() => {
  void mock.module('@repo/net/teams-webhook', () => realTeams);
  void mock.module('@repo/net/teams-bot', () => realBot);
  delete process.env.TEAMS_BOT_APP_ID;
  delete process.env.TEAMS_BOT_APP_PASSWORD;
  delete process.env.TEAMS_BOT_TENANT_ID;
});

const URL_OK = 'https://prod-1.westus.logic.azure.com/workflows/x?sig=SECRET';

async function setup(teamsEnabled: boolean, withWebhook = true) {
  const [ws] = await db.insert(workspace).values({ name: 'Teams' }).returning({ id: workspace.id });
  const [t] = await db
    .insert(team)
    .values({ workspaceId: ws!.id, name: 'Teams' })
    .returning({ id: team.id });
  const [p] = await db
    .insert(project)
    .values({ teamId: t!.id, key: randomUUID().slice(0, 8), name: 'P' })
    .returning({ id: project.id });
  const userId = randomUUID();
  await db.insert(user).values({
    id: userId,
    name: 'Member',
    email: `${userId}@example.com`,
    emailVerified: true,
  });
  if (teamsEnabled) {
    const config = { teams: { enabled: true } };
    const enc = encryptSecret(JSON.stringify(config));
    await db.insert(teamNotificationSetting).values({ teamId: t!.id, ...enc, redacted: config });
  }
  if (withWebhook) {
    const enc = encryptSecret(URL_OK);
    await db
      .insert(userTeamsWebhook)
      .values({ userId, ...enc, host: 'prod-1.westus.logic.azure.com' });
  }
  return { projectId: p!.id, userId };
}

const payload = { subject: 'IAP-1: assigned to you', text: 'Body', url: 'https://x.test/i' };

describe('deliverNotification over Teams', () => {
  beforeEach(async () => {
    await db.delete(appSecret);
    posts.length = 0;
    reply = { ok: true };
  });

  it('posts the decrypted url and the card', async () => {
    const { projectId, userId } = await setup(true);
    const result = await deliverNotification({
      projectId,
      channel: 'teams',
      recipient: userId,
      payload,
    });
    expect(result).toEqual({ ok: true });
    expect(posts).toEqual([
      { url: URL_OK, card: { title: payload.subject, text: 'Body', url: payload.url } },
    ]);
  });

  it('fails permanently, without posting, while the team gate is off', async () => {
    const { projectId, userId } = await setup(false);
    const result = await deliverNotification({
      projectId,
      channel: 'teams',
      recipient: userId,
      payload,
    });
    expect(result).toEqual({ ok: false, retryable: false, error: 'teams not enabled' });
    expect(posts).toHaveLength(0);
  });

  it('fails permanently when the member has no webhook', async () => {
    const { projectId, userId } = await setup(true, false);
    const result = await deliverNotification({
      projectId,
      channel: 'teams',
      recipient: userId,
      payload,
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('marks the connection broken on a permanent failure', async () => {
    const { projectId, userId } = await setup(true);
    reply = { ok: false, retryable: false, error: 'Teams HTTP 404: gone' };
    const result = await deliverNotification({
      projectId,
      channel: 'teams',
      recipient: userId,
      payload,
    });
    expect(result).toMatchObject({ ok: false, retryable: false });
    const [row] = await db
      .select()
      .from(userTeamsWebhook)
      .where(eq(userTeamsWebhook.userId, userId));
    expect(row!.brokenAt).not.toBeNull();
    expect(row!.lastError).toBe('Teams HTTP 404: gone');
  });

  it('leaves the connection intact on a retryable failure', async () => {
    const { projectId, userId } = await setup(true);
    reply = { ok: false, retryable: true, error: 'Teams HTTP 429: slow down' };
    const result = await deliverNotification({
      projectId,
      channel: 'teams',
      recipient: userId,
      payload,
    });
    expect(result).toMatchObject({ ok: false, retryable: true });
    const [row] = await db
      .select()
      .from(userTeamsWebhook)
      .where(eq(userTeamsWebhook.userId, userId));
    expect(row!.brokenAt).toBeNull();
  });

  describe('with the Teams bot', () => {
    async function linkBot(userId: string) {
      await db.insert(userTeamsBotAccount).values({
        userId,
        teamsUserId: `29:${userId}`,
        serviceUrl: 'https://smba.trafficmanager.net/emea/',
        conversationId: 'a:conv',
        linkedAt: new Date(),
      });
    }

    beforeEach(() => {
      botSent.length = 0;
      botReply = { ok: true };
      process.env.TEAMS_BOT_APP_ID = 'app';
      process.env.TEAMS_BOT_APP_PASSWORD = 'pw';
      process.env.TEAMS_BOT_TENANT_ID = 'tenant';
    });

    it('sends through the bot instead of the webhook when the member linked it', async () => {
      const { projectId, userId } = await setup(true);
      await linkBot(userId);
      const result = await deliverNotification({
        projectId,
        channel: 'teams',
        recipient: userId,
        payload,
      });
      expect(result).toEqual({ ok: true });
      expect(botSent).toEqual([
        {
          conversation: {
            serviceUrl: 'https://smba.trafficmanager.net/emea/',
            conversationId: 'a:conv',
          },
          card: { title: payload.subject, text: 'Body', url: payload.url },
        },
      ]);
      expect(posts).toHaveLength(0);
    });

    it('sends through the bot for a member with no webhook', async () => {
      const { projectId, userId } = await setup(true, false);
      await linkBot(userId);
      expect(
        await deliverNotification({ projectId, channel: 'teams', recipient: userId, payload }),
      ).toEqual({ ok: true });
    });

    it('marks the link broken when the conversation is gone', async () => {
      const { projectId, userId } = await setup(true);
      await linkBot(userId);
      botReply = { ok: false, retryable: false, error: 'Teams bot HTTP 403', gone: true };
      const result = await deliverNotification({
        projectId,
        channel: 'teams',
        recipient: userId,
        payload,
      });
      expect(result).toEqual({ ok: false, retryable: false, error: 'Teams bot HTTP 403' });
      const [row] = await db
        .select()
        .from(userTeamsBotAccount)
        .where(eq(userTeamsBotAccount.userId, userId));
      expect(row!.brokenAt).not.toBeNull();
    });

    it('keeps the link on a retryable failure', async () => {
      const { projectId, userId } = await setup(true);
      await linkBot(userId);
      botReply = { ok: false, retryable: true, error: 'Teams bot HTTP 429', gone: false };
      const result = await deliverNotification({
        projectId,
        channel: 'teams',
        recipient: userId,
        payload,
      });
      expect(result).toMatchObject({ retryable: true });
      const [row] = await db
        .select()
        .from(userTeamsBotAccount)
        .where(eq(userTeamsBotAccount.userId, userId));
      expect(row!.brokenAt).toBeNull();
    });

    it('falls back to the webhook while the link is broken', async () => {
      const { projectId, userId } = await setup(true);
      await linkBot(userId);
      await db
        .update(userTeamsBotAccount)
        .set({ brokenAt: new Date() })
        .where(eq(userTeamsBotAccount.userId, userId));
      await deliverNotification({ projectId, channel: 'teams', recipient: userId, payload });
      expect(botSent).toHaveLength(0);
      expect(posts).toHaveLength(1);
    });
  });
});
