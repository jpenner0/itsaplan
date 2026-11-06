import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  appSecret,
  db,
  project,
  team,
  teamNotificationSetting,
  user,
  userTeamsWebhook,
  workspace,
} from '@repo/db';
import { encryptSecret } from '@repo/crypto';
import { eq } from 'drizzle-orm';
import * as realTeams from '@repo/net/teams-webhook';
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
afterAll(() => {
  void mock.module('@repo/net/teams-webhook', () => realTeams);
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
});
