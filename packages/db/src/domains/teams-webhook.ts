import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decryptSecret } from '@repo/crypto';
import { db } from '../client';
import { userTeamsWebhook } from '../schema/app';

// A member's Teams Workflows webhook URL, stored encrypted in user_teams_webhook. The
// api writes it and builds the enqueue decision from the rows; the worker decrypts it
// at send time. The URL never leaves the server.

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

// Which of these members have a webhook that is not marked broken, for the enqueue path.
export async function getUsableTeamsUserIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: userTeamsWebhook.userId })
    .from(userTeamsWebhook)
    .where(and(inArray(userTeamsWebhook.userId, userIds), isNull(userTeamsWebhook.brokenAt)));
  return new Set(rows.map((r) => r.userId));
}

export async function markTeamsWebhookBroken(userId: string, error: string): Promise<void> {
  await db
    .update(userTeamsWebhook)
    .set({ brokenAt: new Date(), lastError: error.slice(0, 500) })
    .where(eq(userTeamsWebhook.userId, userId));
}
