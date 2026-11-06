import { db, userTeamsWebhook } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { encryptSecret } from '@repo/crypto';
import { UrlNotAllowedError } from '@repo/net';
import { assertTeamsWebhookUrl, postTeamsCard } from '@repo/net/teams-webhook';
import { HttpError } from '#shared/lib';

// The session user's Microsoft Teams Workflows webhook. The URL is a secret: it is
// stored encrypted and only its host is ever returned.

export interface TeamsWebhookDto {
  connected: boolean;
  host: string | null;
  broken: boolean;
  lastError: string | null;
}

export async function getTeamsWebhook(userId: string): Promise<TeamsWebhookDto> {
  const [row] = await db
    .select({
      host: userTeamsWebhook.host,
      brokenAt: userTeamsWebhook.brokenAt,
      lastError: userTeamsWebhook.lastError,
    })
    .from(userTeamsWebhook)
    .where(eq(userTeamsWebhook.userId, userId));
  if (!row) return { connected: false, host: null, broken: false, lastError: null };
  return {
    connected: true,
    host: row.host,
    broken: row.brokenAt !== null,
    lastError: row.lastError,
  };
}

// Stores the URL only when Teams accepts a test card. Saving again also clears a
// broken connection.
export async function saveTeamsWebhook(userId: string, rawUrl: string): Promise<TeamsWebhookDto> {
  let url: URL;
  try {
    url = assertTeamsWebhookUrl(rawUrl);
  } catch (err) {
    if (err instanceof UrlNotAllowedError) throw new HttpError(400, err.message);
    throw err;
  }
  const test = await postTeamsCard(url.toString(), {
    title: "It's a Plan is connected",
    text: 'Notifications from It’s a Plan will appear here.',
  });
  if (!test.ok) throw new HttpError(400, `Teams did not accept the test message: ${test.error}`);

  const enc = encryptSecret(url.toString());
  const values = { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, host: url.host };
  await db
    .insert(userTeamsWebhook)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: userTeamsWebhook.userId,
      set: { ...values, brokenAt: null, lastError: null, updatedAt: sql`now()` },
    });
  return getTeamsWebhook(userId);
}

export async function deleteTeamsWebhook(userId: string): Promise<void> {
  await db.delete(userTeamsWebhook).where(eq(userTeamsWebhook.userId, userId));
}
