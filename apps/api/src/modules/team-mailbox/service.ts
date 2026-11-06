import { aiAgent, db, readMailboxSecret, teamMailbox, user, type MailboxSecret } from '@repo/db';
import { encryptSecret } from '@repo/crypto';
import { resolveHostForConnect, UrlNotAllowedError } from '@repo/net';
import { and, eq } from 'drizzle-orm';
import { HttpError, rethrowDuplicate } from '#shared/lib';
import type { Static } from 'elysia';
import type { TeamMailboxCreateBody, TeamMailboxUpdateBody } from './model';

// The mailbox of a team for the email intake: at most one per team. The stored shape and the
// decrypting reader live in @repo/db (the worker connects with them).

type CreateBody = Static<typeof TeamMailboxCreateBody>;
type UpdateBody = Static<typeof TeamMailboxUpdateBody>;

interface Redacted {
  tenantId?: string;
  clientId?: string;
  hasSecret?: boolean;
}

async function assertHost(host: string): Promise<void> {
  try {
    await resolveHostForConnect(host);
  } catch (err) {
    if (err instanceof UrlNotAllowedError) throw new HttpError(400, `IMAP host: ${err.message}`);
    throw err;
  }
}

async function assertAgent(teamId: number, agentId: number): Promise<void> {
  const [agent] = await db
    .select({ id: aiAgent.id })
    .from(aiAgent)
    .where(and(eq(aiAgent.id, agentId), eq(aiAgent.teamId, teamId), eq(aiAgent.kind, 'internal')));
  if (!agent) throw new HttpError(400, 'Choose an internal agent of the team');
}

// Lowercased and trimmed: an address or `@domain`.
function normalizeSenders(senders: string[]): string[] {
  const out = senders.map((s) => s.trim().toLowerCase());
  for (const s of out) {
    const valid = s.startsWith('@')
      ? /^@[^\s@]+\.[^\s@]+$/.test(s)
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    if (!valid) throw new HttpError(400, `Allowed sender "${s}" is not an address or @domain`);
  }
  return [...new Set(out)];
}

function secretOf(
  auth: 'password' | 'microsoft365',
  body: UpdateBody,
  current: MailboxSecret | null,
): { secret: MailboxSecret; redacted: Redacted } {
  if (auth === 'password') {
    const password = body.password || current?.password;
    if (!password) throw new HttpError(400, 'A password is required');
    return { secret: { password }, redacted: { hasSecret: true } };
  }
  const tenantId = body.tenantId || current?.oauth?.tenantId;
  const clientId = body.clientId || current?.oauth?.clientId;
  const clientSecret = body.clientSecret || current?.oauth?.clientSecret;
  if (!tenantId || !clientId || !clientSecret) {
    throw new HttpError(400, 'Tenant ID, client ID and client secret are required');
  }
  return {
    secret: { oauth: { tenantId, clientId, clientSecret } },
    redacted: { tenantId, clientId, hasSecret: true },
  };
}

async function readRow(teamId: number) {
  const [row] = await db
    .select({ box: teamMailbox, agentName: user.name })
    .from(teamMailbox)
    .innerJoin(aiAgent, eq(aiAgent.id, teamMailbox.agentId))
    .innerJoin(user, eq(user.id, aiAgent.userId))
    .where(eq(teamMailbox.teamId, teamId));
  return row;
}

function toDto({ box, agentName }: NonNullable<Awaited<ReturnType<typeof readRow>>>) {
  const redacted = box.redacted as Redacted;
  return {
    host: box.host,
    port: box.port,
    secure: box.secure,
    auth: box.auth as 'password' | 'microsoft365',
    username: box.username,
    tenantId: redacted.tenantId ?? null,
    clientId: redacted.clientId ?? null,
    hasSecret: redacted.hasSecret ?? false,
    agentId: box.agentId,
    agentName,
    allowedSenders: box.allowedSenders,
    status: box.status as 'active' | 'paused',
    lastError: box.lastError,
    lastPolledAt: box.lastPolledAt,
  };
}

export async function getTeamMailbox(teamId: number) {
  const row = await readRow(teamId);
  if (!row) throw new HttpError(404, 'This team has no mailbox');
  return toDto(row);
}

export async function createTeamMailbox(teamId: number, body: CreateBody) {
  await assertHost(body.host);
  await assertAgent(teamId, body.agentId);
  const allowedSenders = normalizeSenders(body.allowedSenders);
  const { secret, redacted } = secretOf(body.auth, body, null);
  try {
    await db.insert(teamMailbox).values({
      teamId,
      agentId: body.agentId,
      host: body.host,
      port: body.port,
      secure: body.secure,
      auth: body.auth,
      username: body.username,
      ...encryptSecret(JSON.stringify(secret)),
      redacted,
      allowedSenders,
    });
  } catch (err) {
    rethrowDuplicate(err, 'mailbox for this team');
  }
  return getTeamMailbox(teamId);
}

// A paused mailbox is started again when the sign-in is replaced: the admin fixed what made
// it fail. The watermark stays, so mail that arrived while it was paused is still read.
export async function updateTeamMailbox(teamId: number, body: UpdateBody) {
  const [row] = await db.select().from(teamMailbox).where(eq(teamMailbox.teamId, teamId));
  if (!row) throw new HttpError(404, 'This team has no mailbox');
  const host = body.host ?? row.host;
  if (host !== row.host) await assertHost(host);
  const agentId = body.agentId ?? row.agentId;
  if (agentId !== row.agentId) await assertAgent(teamId, agentId);
  const allowedSenders = body.allowedSenders
    ? normalizeSenders(body.allowedSenders)
    : row.allowedSenders;
  const auth = body.auth ?? (row.auth as 'password' | 'microsoft365');
  const current = auth === row.auth ? readMailboxSecret(row) : null;
  const { secret, redacted } = secretOf(auth, body, current);
  const replaced =
    auth === 'password'
      ? Boolean(body.password)
      : Boolean(body.tenantId || body.clientId || body.clientSecret);
  await db
    .update(teamMailbox)
    .set({
      host,
      port: body.port ?? row.port,
      secure: body.secure ?? row.secure,
      auth,
      username: body.username ?? row.username,
      agentId,
      allowedSenders,
      ...encryptSecret(JSON.stringify(secret)),
      redacted,
      ...(replaced
        ? { status: 'active', failures: 0, lastError: null, nextPollAt: new Date() }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(teamMailbox.id, row.id));
  return getTeamMailbox(teamId);
}

export async function deleteTeamMailbox(teamId: number): Promise<void> {
  const rows = await db
    .delete(teamMailbox)
    .where(eq(teamMailbox.teamId, teamId))
    .returning({ id: teamMailbox.id });
  if (rows.length === 0) throw new HttpError(404, 'This team has no mailbox');
}
