import { beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  agentRun,
  aiAgent,
  db,
  intakeItem,
  issue,
  project,
  projectColumn,
  projectMember,
  team,
  teamMailbox,
  user,
  workspace,
} from '@repo/db';
import { encryptSecret } from '@repo/crypto';
import { eq } from 'drizzle-orm';
import { ImapAuthError, type MailSession } from '../../mail-imap';
import { pollMailbox, syncMailbox } from '../../mail-sync';
import { claimDueMailboxes, deleteExpiredRejected } from '../../mail-store';

async function makeBox(over: Partial<typeof teamMailbox.$inferInsert> = {}) {
  const [ws] = await db.insert(workspace).values({ name: 'Mail' }).returning({ id: workspace.id });
  const [t] = await db
    .insert(team)
    .values({ workspaceId: ws!.id, name: 'Mail' })
    .returning({ id: team.id });
  const botId = randomUUID();
  await db.insert(user).values({ id: botId, name: 'Bot', email: `${botId}@example.test` });
  const [agent] = await db
    .insert(aiAgent)
    .values({ teamId: t!.id, userId: botId, username: 'triage', kind: 'internal' })
    .returning({ id: aiAgent.id });
  const [box] = await db
    .insert(teamMailbox)
    .values({
      teamId: t!.id,
      agentId: agent!.id,
      host: 'imap.example.com',
      username: 'support@example.com',
      allowedSenders: ['example.com'],
      ...encryptSecret(JSON.stringify({ password: 'pw' })),
      ...over,
    })
    .returning();
  return box!;
}

const PASS = 'Authentication-Results: mx.example.net; dmarc=pass header.from=example.com';

function raw(id: string, auth = PASS, from = 'a@example.com'): Buffer {
  return Buffer.from(
    `${auth}\r\nFrom: ${from}\r\nSubject: Hi\r\nMessage-ID: <${id}@x>\r\n\r\nbody ${id}`,
  );
}

function session(
  uidValidity: number,
  uidNext: number,
  messages: { uid: number; source: Buffer }[] = [],
): MailSession {
  return {
    uidValidity,
    uidNext,
    fetchAfter: async (after, limit) => messages.filter((m) => m.uid > after).slice(0, limit),
    close: async () => undefined,
  };
}

async function reload(id: number) {
  const [row] = await db.select().from(teamMailbox).where(eq(teamMailbox.id, id));
  return row!;
}

async function triageRuns() {
  return db.select().from(agentRun).where(eq(agentRun.trigger, 'mail_triage'));
}

async function addProject(box: typeof teamMailbox.$inferSelect, key: string) {
  const [agent] = await db.select().from(aiAgent).where(eq(aiAgent.id, box.agentId));
  const [p] = await db
    .insert(project)
    .values({ teamId: box.teamId, key, name: key })
    .returning({ id: project.id });
  await db.insert(projectMember).values({ projectId: p!.id, userId: agent!.userId });
  return p!.id;
}

beforeEach(async () => {
  await db.delete(teamMailbox);
});

describe('syncMailbox', () => {
  it('sets the watermark to the highest UID on the first poll and reads nothing', async () => {
    const box = await makeBox();
    const ids = await syncMailbox(box, session(7, 11, [{ uid: 10, source: raw('old') }]));
    expect(ids).toEqual([]);
    expect(await reload(box.id)).toMatchObject({ uidValidity: 7, lastUid: 10 });
    expect(await db.select().from(intakeItem)).toHaveLength(0);
  });

  it('stores only mail above the watermark and moves it', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    const ids = await syncMailbox(
      box,
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
    expect((await reload(box.id)).lastUid).toBe(13);
  });

  it('reads at most 50 messages per poll', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 0 });
    const messages = Array.from({ length: 60 }, (_, i) => ({
      uid: i + 1,
      source: raw(`m${i}`),
    }));
    await syncMailbox(box, session(7, 61, messages));
    expect(await db.select().from(intakeItem)).toHaveLength(50);
    expect((await reload(box.id)).lastUid).toBe(50);
  });

  it('does not store a message id twice', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    await syncMailbox(box, session(7, 13, [{ uid: 11, source: raw('a') }]));
    await syncMailbox(await reload(box.id), session(7, 13, [{ uid: 12, source: raw('a') }]));
    expect(await db.select().from(intakeItem)).toHaveLength(1);
  });

  it('resets the watermark when UIDVALIDITY changes', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    const ids = await syncMailbox(box, session(8, 5, [{ uid: 3, source: raw('x') }]));
    expect(ids).toEqual([]);
    expect(await reload(box.id)).toMatchObject({ uidValidity: 8, lastUid: 4 });
  });
});

describe('sender check', () => {
  async function run(box: typeof teamMailbox.$inferSelect, source: Buffer) {
    await syncMailbox(box, session(7, 12, [{ uid: 11, source }]));
    const [item] = await db.select().from(intakeItem);
    return { item: item!, runs: await triageRuns() };
  }

  it('queues triage for a listed and authenticated sender', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    await addProject(box, 'MAIL');
    const { item, runs } = await run(box, raw('a'));
    expect(item.senderAllowed).toBe(true);
    expect(runs).toMatchObject([{ agentId: box.agentId, intakeItemId: item.id }]);
  });

  it('stores a listed but unauthenticated sender without triage', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    await addProject(box, 'MAIL');
    const { item, runs } = await run(box, raw('a', 'Authentication-Results: mx; dmarc=fail'));
    expect(item.senderAllowed).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('stores an email with no Authentication-Results header without triage', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    await addProject(box, 'MAIL');
    const { item, runs } = await run(box, raw('a', 'X-Other: 1'));
    expect(item.senderAllowed).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('stores an authenticated sender that is not listed without triage', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10, allowedSenders: ['other.org'] });
    await addProject(box, 'MAIL');
    const { item, runs } = await run(box, raw('a'));
    expect(item.senderAllowed).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('lets nobody in when the list is empty', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10, allowedSenders: [] });
    await addProject(box, 'MAIL');
    const { item, runs } = await run(box, raw('a'));
    expect(item.senderAllowed).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('rejects a forged From: the result vouches for another domain', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10, allowedSenders: ['boss@corp.com'] });
    await addProject(box, 'MAIL');
    const forged = raw(
      'a',
      'Authentication-Results: mx; dmarc=pass header.from=evil.test; spf=pass smtp.mailfrom=evil.test',
      'boss@corp.com',
    );
    const { item, runs } = await run(box, forged);
    expect(item.senderAllowed).toBe(false);
    expect(runs).toHaveLength(0);
  });
});

describe('replies', () => {
  async function acceptedMail(box: typeof teamMailbox.$inferSelect) {
    const [p] = await db
      .insert(project)
      .values({ teamId: box.teamId, key: 'REP', name: 'Replies' })
      .returning({ id: project.id });
    const [col] = await db
      .insert(projectColumn)
      .values({ projectId: p!.id, name: 'Todo', position: 0 })
      .returning({ id: projectColumn.id });
    const [created] = await db
      .insert(issue)
      .values({ projectId: p!.id, sequenceNumber: 1, columnId: col!.id, title: 'T' })
      .returning({ id: issue.id });
    await db.insert(intakeItem).values({
      teamMailboxId: box.id,
      messageId: '<root@x>',
      fromAddress: 'a@example.com',
      status: 'accepted',
      issueId: created!.id,
    });
    return created!.id;
  }

  const reply = (id: string, header: string, auth = PASS) =>
    Buffer.from(`${auth}\r\nFrom: a@example.com\r\nMessage-ID: <${id}@x>\r\n${header}\r\n\r\nmore`);

  it('marks an answer to an accepted email, matched by In-Reply-To or References, and queues no triage', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    await addProject(box, 'MAIL');
    const issueId = await acceptedMail(box);

    await syncMailbox(
      box,
      session(7, 13, [
        { uid: 11, source: reply('r1', 'In-Reply-To: <root@x>') },
        { uid: 12, source: reply('r2', 'References: <other@x> <r1@x> <root@x>') },
      ]),
    );

    const items = await db.select().from(intakeItem).orderBy(intakeItem.id);
    expect(items.slice(1).map((i) => i.replyToIssueId)).toEqual([issueId, issueId]);
    expect(await triageRuns()).toHaveLength(0);
  });

  it('does not post an answer from an unauthenticated sender as a comment', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    await acceptedMail(box);
    await syncMailbox(
      box,
      session(7, 12, [{ uid: 11, source: reply('r1', 'In-Reply-To: <root@x>', 'X-Other: 1') }]),
    );
    const [, item] = await db.select().from(intakeItem).orderBy(intakeItem.id);
    expect(item).toMatchObject({ replyToIssueId: null, senderAllowed: false });
  });

  it('does not match an answer to another mailbox or an undecided email', async () => {
    const box = await makeBox({ uidValidity: 7, lastUid: 10 });
    const other = await makeBox({ uidValidity: 7, lastUid: 10 });
    await acceptedMail(other);
    await db.insert(intakeItem).values({
      teamMailboxId: box.id,
      messageId: '<pending@x>',
      fromAddress: 'a@example.com',
    });

    await syncMailbox(
      box,
      session(7, 13, [
        { uid: 11, source: reply('r1', 'In-Reply-To: <root@x>') },
        { uid: 12, source: reply('r2', 'In-Reply-To: <pending@x>') },
      ]),
    );

    const mine = await db.select().from(intakeItem).where(eq(intakeItem.teamMailboxId, box.id));
    expect(mine.every((i) => i.replyToIssueId === null)).toBe(true);
  });
});

describe('pollMailbox', () => {
  it('pauses the mailbox after three sign-in failures in a row', async () => {
    const box = await makeBox();
    const fail = async () => {
      throw new ImapAuthError('Invalid credentials');
    };
    for (let i = 0; i < 3; i++) await pollMailbox(box.id, fail);
    expect(await reload(box.id)).toMatchObject({
      status: 'paused',
      failures: 3,
      lastError: 'Invalid credentials',
    });
  });

  it('does not count another error toward pausing and clears errors on success', async () => {
    const box = await makeBox();
    await pollMailbox(box.id, async () => {
      throw new Error('timeout');
    });
    expect(await reload(box.id)).toMatchObject({
      status: 'active',
      failures: 0,
      lastError: 'timeout',
    });
    await pollMailbox(box.id, async () => session(1, 1));
    expect((await reload(box.id)).lastError).toBeNull();
  });
});

describe('claimDueMailboxes', () => {
  it('claims a due active mailbox once and skips a paused one', async () => {
    const a = await makeBox();
    await makeBox({ status: 'paused' });
    expect(await claimDueMailboxes()).toEqual([a.id]);
    expect(await claimDueMailboxes()).toEqual([]);
  });
});

describe('deleteExpiredRejected', () => {
  it('deletes rejected items after 30 days and keeps newer and undecided ones', async () => {
    const box = await makeBox();
    const old = new Date(Date.now() - 31 * 86_400_000);
    const recent = new Date(Date.now() - 5 * 86_400_000);
    const base = { teamMailboxId: box.id, fromAddress: 'a@b.c' };
    await db.insert(intakeItem).values([
      { ...base, messageId: '<1>', status: 'rejected', decidedAt: old },
      { ...base, messageId: '<2>', status: 'rejected', decidedAt: recent },
      { ...base, messageId: '<3>', status: 'new' },
    ]);
    expect(await deleteExpiredRejected()).toBe(1);
    const left = await db
      .select({ m: intakeItem.messageId })
      .from(intakeItem)
      .orderBy(intakeItem.id);
    expect(left.map((r) => r.m)).toEqual(['<2>', '<3>']);
  });
});
