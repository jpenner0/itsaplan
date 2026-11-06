import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { decryptSecret } from '@repo/crypto';
import { db } from '../client';
import { userTeamsBotAccount, userTeamsWebhook } from '../schema/app';

// A member's Microsoft Teams destinations: a Workflows webhook URL stored encrypted in
// user_teams_webhook, and a conversation with the instance's Teams bot in
// user_teams_bot_account. The api writes both; the worker reads them at send time. The
// webhook URL never leaves the server.

// The decrypted URL, or null when the member has none.
export async function readTeamsWebhookUrl(userId: string): Promise<string | null> {
  const [row] = await db
    .select({
      ciphertext: userTeamsWebhook.ciphertext,
      iv: userTeamsWebhook.iv,
      authTag: userTeamsWebhook.authTag,
    })
    .from(userTeamsWebhook)
    .where(eq(userTeamsWebhook.userId, userId));
  return row ? decryptSecret(row) : null;
}

// The member's bot conversation, or null when not linked or marked broken.
export async function readTeamsBotConversation(
  userId: string,
): Promise<{ serviceUrl: string; conversationId: string } | null> {
  const [row] = await db
    .select({
      serviceUrl: userTeamsBotAccount.serviceUrl,
      conversationId: userTeamsBotAccount.conversationId,
    })
    .from(userTeamsBotAccount)
    .where(
      and(
        eq(userTeamsBotAccount.userId, userId),
        isNotNull(userTeamsBotAccount.linkedAt),
        isNull(userTeamsBotAccount.brokenAt),
      ),
    );
  return row?.serviceUrl && row.conversationId
    ? { serviceUrl: row.serviceUrl, conversationId: row.conversationId }
    : null;
}

// Which of these members can receive a Teams delivery, for the enqueue path: a webhook
// that is not broken, or (when the instance runs the bot) a linked bot conversation
// that is not broken.
export async function getUsableTeamsUserIds(
  userIds: string[],
  botConfigured: boolean,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const [hooks, bots] = await Promise.all([
    db
      .select({ userId: userTeamsWebhook.userId })
      .from(userTeamsWebhook)
      .where(and(inArray(userTeamsWebhook.userId, userIds), isNull(userTeamsWebhook.brokenAt))),
    botConfigured
      ? db
          .select({ userId: userTeamsBotAccount.userId })
          .from(userTeamsBotAccount)
          .where(
            and(
              inArray(userTeamsBotAccount.userId, userIds),
              isNotNull(userTeamsBotAccount.linkedAt),
              isNull(userTeamsBotAccount.brokenAt),
            ),
          )
      : Promise.resolve([]),
  ]);
  return new Set([...hooks, ...bots].map((r) => r.userId));
}

export async function markTeamsWebhookBroken(userId: string, error: string): Promise<void> {
  await db
    .update(userTeamsWebhook)
    .set({ brokenAt: new Date(), lastError: error.slice(0, 500) })
    .where(eq(userTeamsWebhook.userId, userId));
}

export async function markTeamsBotBroken(userId: string, error: string): Promise<void> {
  await db
    .update(userTeamsBotAccount)
    .set({ brokenAt: new Date(), lastError: error.slice(0, 500) })
    .where(eq(userTeamsBotAccount.userId, userId));
}
