import { beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  agentRun,
  aiAgent,
  db,
  intakeItem,
  mailbox,
  mailboxFolder,
  project,
  projectMember,
  team,
  user,
  workspace,
} from '@repo/db';
import { encryptSecret } from '@repo/crypto';
import { eq } from 'drizzle-orm';
import { ImapAuthError, type FolderSession } from '../../mail-imap';
import { pollFolder, syncFolder } from '../../mail-sync';
import { claimDueFolders, deleteExpiredRejected, type DueFolder } from '../../mail-store';

async function makeFolder(over: Partial<typeof mailboxFolder.$inferInsert> = {}) {
  const [ws] = await db.insert(workspace).values({ name: 'Mail' }).returning({ id: workspace.id });
  const [t] = await db
    .insert(team)
    .values({ workspaceId: ws!.id, name: 'Mail' })
    .returning({ id: team.id });
  const ownerId = randomUUID();
  const botId = randomUUID();
  await db.insert(user).values([
    { id: ownerId, name: 'Owner', email: `${ownerId}@example.test` },
    { id: botId, name: 'Bot', email: `${botId}@example.test` },
  ]);
  const [agent] = await db
    .insert(aiAgent)
    .values({ teamId: t!.id, userId: botId, username: 'triage', kind: 'internal' })
    .returning({ id: aiAgent.id });
  const [box] = await db
    .insert(mailbox)
    .values({
      userId: ownerId,
      label: 'Support',
      host: 'imap.example.com',
      username: 'support@example.com',
      ...encryptSecret(JSON.stringify({ password: 'pw' })),
    })
    .returning();
  const [folder] = await db
    .insert(mailboxFolder)
    .values({ mailboxId: box!.id, name: 'INBOX', teamId: t!.id, agentId: agent!.id, ...over })
    .returning();
  return { folder: folder!, box: box! };
}

function due(f: typeof mailboxFolder.$inferSelect): DueFolder {
  return {
    id: f.id,
    name: f.name,
    uidValidity: f.uidValidity,
    lastUid: f.lastUid,
    failures: f.failures,
    mailboxId: f.mailboxId,
  };
}

function raw(id: string, subject = 'Hi'): Buffer {
  return Buffer.from(
    `From: a@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${id}@x>\r\n\r\nbody ${id}`,
  );
}

function session(
  uidValidity: number,
  uidNext: number,
  messages: { uid: number; source: Buffer }[] = [],
): FolderSession {
  return {
    uidValidity,
    uidNext,
    fetchAfter: async (after, limit) => messages.filter((m) => m.uid > after).slice(0, limit),
    close: async () => undefined,
  };
}

async function reload(id: number) {
  const [row] = await db.select().from(mailboxFolder).where(eq(mailboxFolder.id, id));
  return row!;
}

describe('syncFolder', () => {
  beforeEach(async () => {
    await db.delete(mailboxFolder);
  });

  it('sets the watermark to the highest UID on the first poll and reads nothing', async () => {
    const { folder } = await makeFolder();
    const ids = await syncFolder(due(folder), session(7, 11, [{ uid: 10, source: raw('old') }]));
    expect(ids).toEqual([]);
    expect(await reload(folder.id)).toMatchObject({ uidValidity: 7, lastUid: 10 });
    expect(await db.select().from(intakeItem)).toHaveLength(0);
  });

  it('stores only mail above the watermark and moves it', async () => {
    const { folder } = await makeFolder({ uidValidity: 7, lastUid: 10 });
    const ids = await syncFolder(
      due(folder),
      session(7, 14, [
        { uid: 10, source: raw('old') },
        { uid: 11, source: raw('a') },
        { uid: 13, source: raw('b') },
      ]),
    );
    expect(ids).toHaveLength(2);
    const items = await db.select().from(intakeItem).orderBy(intakeItem.id);
    expect(items.map((i) => i.messageId)).toEqual(['<a@x>', '<b@x>']);
    expect(items[0]).toMatchObject({ fromAddress: 'a@example.com', status: 'new' });
    expect((await reload(folder.id)).lastUid).toBe(13);
  });

  it('queues a triage run of the folder agent in a project it works in', async () => {
    const { folder } = await makeFolder({ uidValidity: 7, lastUid: 10 });
    const [agent] = await db.select().from(aiAgent).where(eq(aiAgent.id, folder.agentId));
    await syncFolder(due(folder), session(7, 12, [{ uid: 11, source: raw('a') }]));
    expect(await db.select().from(agentRun)).toHaveLength(0);

    const [p] = await db
      .insert(project)
      .values({ teamId: folder.teamId, key: 'MAIL', name: 'Mail' })
      .returning({ id: project.id });
    await db.insert(projectMember).values({ projectId: p!.id, userId: agent!.userId });
    const [item] = await db.select().from(intakeItem);
    await db.delete(intakeItem).where(eq(intakeItem.id, item!.id));
    await syncFolder(due(await reload(folder.id)), session(7, 13, [{ uid: 12, source: raw('b') }]));

    const [created] = await db.select().from(intakeItem);
    expect(await db.select().from(agentRun)).toMatchObject([
      {
        agentId: folder.agentId,
        projectId: p!.id,
        trigger: 'mail_triage',
        intakeItemId: created!.id,
        status: 'pending',
      },
    ]);
  });

  it('does not store a message id twice', async () => {
    const { folder } = await makeFolder({ uidValidity: 7, lastUid: 10 });
    await syncFolder(due(folder), session(7, 13, [{ uid: 11, source: raw('a') }]));
    await syncFolder(due(await reload(folder.id)), session(7, 13, [{ uid: 12, source: raw('a') }]));
    expect(await db.select().from(intakeItem)).toHaveLength(1);
  });

  it('resets the watermark when UIDVALIDITY changes', async () => {
    const { folder } = await makeFolder({ uidValidity: 7, lastUid: 10 });
    const ids = await syncFolder(due(folder), session(8, 5, [{ uid: 3, source: raw('x') }]));
    expect(ids).toEqual([]);
    expect(await reload(folder.id)).toMatchObject({ uidValidity: 8, lastUid: 4 });
  });
});

describe('pollFolder', () => {
  beforeEach(async () => {
    await db.delete(mailboxFolder);
  });

  it('pauses the folder after three sign-in failures in a row', async () => {
    const { folder } = await makeFolder();
    const fail = async () => {
      throw new ImapAuthError('Invalid credentials');
    };
    for (let i = 0; i < 3; i++) await pollFolder(due(await reload(folder.id)), fail);
    expect(await reload(folder.id)).toMatchObject({
      status: 'paused',
      failures: 3,
      lastError: 'Invalid credentials',
    });
  });

  it('does not count another error toward pausing and clears errors on success', async () => {
    const { folder } = await makeFolder();
    await pollFolder(due(folder), async () => {
      throw new Error('timeout');
    });
    expect(await reload(folder.id)).toMatchObject({
      status: 'active',
      failures: 0,
      lastError: 'timeout',
    });
    await pollFolder(due(await reload(folder.id)), async () => session(1, 1));
    expect((await reload(folder.id)).lastError).toBeNull();
  });
});

describe('claimDueFolders', () => {
  beforeEach(async () => {
    await db.delete(mailboxFolder);
  });

  it('claims a due active folder once and skips a paused one', async () => {
    const a = await makeFolder();
    await makeFolder({ status: 'paused' });
    expect((await claimDueFolders()).map((f) => f.id)).toEqual([a.folder.id]);
    expect(await claimDueFolders()).toEqual([]);
  });
});

describe('deleteExpiredRejected', () => {
  it('deletes rejected items after 30 days and keeps newer and undecided ones', async () => {
    await db.delete(mailboxFolder);
    const { folder } = await makeFolder();
    const old = new Date(Date.now() - 31 * 86_400_000);
    const recent = new Date(Date.now() - 5 * 86_400_000);
    await db.insert(intakeItem).values([
      {
        folderId: folder.id,
        messageId: '<1>',
        fromAddress: 'a@b.c',
        status: 'rejected',
        decidedAt: old,
      },
      {
        folderId: folder.id,
        messageId: '<2>',
        fromAddress: 'a@b.c',
        status: 'rejected',
        decidedAt: recent,
      },
      { folderId: folder.id, messageId: '<3>', fromAddress: 'a@b.c', status: 'new' },
    ]);
    expect(await deleteExpiredRejected()).toBe(1);
    const left = await db
      .select({ m: intakeItem.messageId })
      .from(intakeItem)
      .orderBy(intakeItem.id);
    expect(left.map((r) => r.m)).toEqual(['<2>', '<3>']);
  });
});
