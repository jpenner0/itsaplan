import {
  aiAgent,
  db,
  mailbox,
  mailboxFolder,
  readMailboxSecret,
  team,
  teamMember,
  user,
  type MailboxSecret,
} from '@repo/db';
import { encryptSecret } from '@repo/crypto';
import { resolveHostForConnect, UrlNotAllowedError } from '@repo/net';
import { and, eq, inArray } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import type { Static } from 'elysia';
import type { FolderBody, MailboxCreateBody, MailboxUpdateBody } from './model';

// The mailboxes of the email intake, as their owner manages them in the account settings. A
// mailbox belongs to one user and every function here is scoped to that user: another user's
// mailbox reads as missing. The stored shape and the decrypting reader live in @repo/db (the
// worker connects with them).

type CreateBody = Static<typeof MailboxCreateBody>;
type UpdateBody = Static<typeof MailboxUpdateBody>;
type MailboxRow = typeof mailbox.$inferSelect;

interface FolderRow {
  id: number;
  mailboxId: number;
  name: string;
  teamId: number;
  teamName: string;
  agentId: number;
  agentName: string;
  status: string;
  lastError: string | null;
  lastPolledAt: Date | null;
}

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

export async function listMailboxes(userId: string) {
  const boxes = await db.select().from(mailbox).where(eq(mailbox.userId, userId));
  if (boxes.length === 0) return [];
  const folders = await db
    .select({
      id: mailboxFolder.id,
      mailboxId: mailboxFolder.mailboxId,
      name: mailboxFolder.name,
      teamId: mailboxFolder.teamId,
      teamName: team.name,
      agentId: mailboxFolder.agentId,
      agentName: user.name,
      status: mailboxFolder.status,
      lastError: mailboxFolder.lastError,
      lastPolledAt: mailboxFolder.lastPolledAt,
    })
    .from(mailboxFolder)
    .innerJoin(team, eq(team.id, mailboxFolder.teamId))
    .innerJoin(aiAgent, eq(aiAgent.id, mailboxFolder.agentId))
    .innerJoin(user, eq(user.id, aiAgent.userId))
    .where(
      inArray(
        mailboxFolder.mailboxId,
        boxes.map((b) => b.id),
      ),
    )
    .orderBy(mailboxFolder.id);
  return boxes
    .sort((a, b) => a.id - b.id)
    .map((b) =>
      toDto(
        b,
        folders.filter((f) => f.mailboxId === b.id),
      ),
    );
}

function toDto(row: MailboxRow, folders: FolderRow[]) {
  const redacted = row.redacted as Redacted;
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    secure: row.secure,
    auth: row.auth as 'password' | 'microsoft365',
    username: row.username,
    tenantId: redacted.tenantId ?? null,
    clientId: redacted.clientId ?? null,
    hasSecret: redacted.hasSecret ?? false,
    folders: folders.map(({ mailboxId: _mailboxId, ...f }) => ({
      ...f,
      status: f.status as 'active' | 'paused',
    })),
  };
}

async function ownedMailbox(userId: string, mailboxId: number): Promise<MailboxRow> {
  const [row] = await db
    .select()
    .from(mailbox)
    .where(and(eq(mailbox.id, mailboxId), eq(mailbox.userId, userId)));
  if (!row) throw new HttpError(404, 'Mailbox not found');
  return row;
}

export async function createMailbox(userId: string, body: CreateBody) {
  await assertHost(body.host);
  const { secret, redacted } = secretOf(body.auth, body, null);
  const [row] = await db
    .insert(mailbox)
    .values({
      userId,
      label: body.label,
      host: body.host,
      port: body.port,
      secure: body.secure,
      auth: body.auth,
      username: body.username,
      ...encryptSecret(JSON.stringify(secret)),
      redacted,
    })
    .returning();
  return toDto(row!, []);
}

// Saves the connection. A paused folder is started again when the sign-in is replaced: the
// user fixed what made it fail. The watermark stays, so mail that arrived while it was
// paused is still read.
export async function updateMailbox(userId: string, mailboxId: number, body: UpdateBody) {
  const row = await ownedMailbox(userId, mailboxId);
  const host = body.host ?? row.host;
  if (host !== row.host) await assertHost(host);
  const auth = body.auth ?? (row.auth as 'password' | 'microsoft365');
  const current = auth === row.auth ? readMailboxSecret(row) : null;
  const { secret, redacted } = secretOf(auth, body, current);
  const replaced = Boolean(body.password || body.clientSecret || body.tenantId || body.clientId);
  await db.transaction(async (tx) => {
    await tx
      .update(mailbox)
      .set({
        label: body.label ?? row.label,
        host,
        port: body.port ?? row.port,
        secure: body.secure ?? row.secure,
        auth,
        username: body.username ?? row.username,
        ...encryptSecret(JSON.stringify(secret)),
        redacted,
        updatedAt: new Date(),
      })
      .where(eq(mailbox.id, mailboxId));
    if (replaced) {
      await tx
        .update(mailboxFolder)
        .set({ status: 'active', failures: 0, lastError: null, nextPollAt: new Date() })
        .where(eq(mailboxFolder.mailboxId, mailboxId));
    }
  });
  return (await listMailboxes(userId)).find((b) => b.id === mailboxId)!;
}

export async function deleteMailbox(userId: string, mailboxId: number): Promise<void> {
  await ownedMailbox(userId, mailboxId);
  await db.delete(mailbox).where(eq(mailbox.id, mailboxId));
}

// The team must be one the user belongs to and the agent an internal agent of that team.
async function assertTeamAndAgent(userId: string, teamId: number, agentId: number): Promise<void> {
  const [member] = await db
    .select({ role: teamMember.role })
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
  if (!member || member.role === 'agent') {
    throw new HttpError(403, 'You are not a member of this team');
  }
  const [agent] = await db
    .select({ id: aiAgent.id })
    .from(aiAgent)
    .where(and(eq(aiAgent.id, agentId), eq(aiAgent.teamId, teamId), eq(aiAgent.kind, 'internal')));
  if (!agent) throw new HttpError(400, 'Choose an internal agent of the team');
}

export async function addFolder(
  userId: string,
  mailboxId: number,
  body: Static<typeof FolderBody>,
) {
  await ownedMailbox(userId, mailboxId);
  await assertTeamAndAgent(userId, body.teamId, body.agentId);
  try {
    await db.insert(mailboxFolder).values({ mailboxId, ...body });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'This folder is already connected');
    }
    throw err;
  }
  return (await listMailboxes(userId)).find((b) => b.id === mailboxId)!;
}

// The folder name is fixed: renaming it would be another folder with another UIDVALIDITY.
export async function updateFolder(
  userId: string,
  mailboxId: number,
  folderId: number,
  body: Pick<Static<typeof FolderBody>, 'teamId' | 'agentId'>,
) {
  await ownedMailbox(userId, mailboxId);
  await assertTeamAndAgent(userId, body.teamId, body.agentId);
  const rows = await db
    .update(mailboxFolder)
    .set({ teamId: body.teamId, agentId: body.agentId })
    .where(and(eq(mailboxFolder.id, folderId), eq(mailboxFolder.mailboxId, mailboxId)))
    .returning({ id: mailboxFolder.id });
  if (rows.length === 0) throw new HttpError(404, 'Folder not found');
  return (await listMailboxes(userId)).find((b) => b.id === mailboxId)!;
}

export async function removeFolder(
  userId: string,
  mailboxId: number,
  folderId: number,
): Promise<void> {
  await ownedMailbox(userId, mailboxId);
  const rows = await db
    .delete(mailboxFolder)
    .where(and(eq(mailboxFolder.id, folderId), eq(mailboxFolder.mailboxId, mailboxId)))
    .returning({ id: mailboxFolder.id });
  if (rows.length === 0) throw new HttpError(404, 'Folder not found');
}

export async function mailboxOptions(userId: string) {
  const teams = await db
    .select({ id: team.id, name: team.name })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(
      and(eq(teamMember.userId, userId), inArray(teamMember.role, ['owner', 'manager', 'member'])),
    )
    .orderBy(team.name);
  if (teams.length === 0) return { teams: [] };
  const agents = await db
    .select({ id: aiAgent.id, teamId: aiAgent.teamId, name: user.name })
    .from(aiAgent)
    .innerJoin(user, eq(user.id, aiAgent.userId))
    .where(
      and(
        eq(aiAgent.kind, 'internal'),
        inArray(
          aiAgent.teamId,
          teams.map((x) => x.id),
        ),
      ),
    )
    .orderBy(user.name);
  return {
    teams: teams.map((x) => ({
      ...x,
      agents: agents.filter((a) => a.teamId === x.id).map(({ teamId: _t, ...a }) => a),
    })),
  };
}
