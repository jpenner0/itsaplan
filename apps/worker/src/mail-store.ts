import { randomUUID } from 'node:crypto';
import {
  agentRun,
  aiAgent,
  db,
  getStorageSettings,
  intakeItem,
  teamMailbox,
  project,
  projectMember,
  mimeAllowed,
  MB,
  type IntakeAttachment,
} from '@repo/db';
import { deleteObjects, putObject, safeAttachmentFilename } from '@repo/storage';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ParsedMail } from './mail-parse';

// Database side of the mail fetch: claiming due mailboxes, the watermark and the stored items.

export const POLL_INTERVAL_SECONDS = 300;
// A mailbox is paused after this many sign-in failures in a row.
export const MAX_AUTH_FAILURES = 3;

// Claims the mailboxes that are due. The claim pushes next_poll_at forward by the poll
// interval, so a second worker replica skips the mailbox and a crashed worker's mailbox
// comes back on the next interval without a recovery pass.
export async function claimDueMailboxes(): Promise<number[]> {
  const rows = await db.execute(sql`
    UPDATE team_mailbox m
    SET next_poll_at = now() + make_interval(secs => ${POLL_INTERVAL_SECONDS})
    WHERE m.id IN (
      SELECT id FROM team_mailbox
      WHERE status = 'active' AND next_poll_at <= now()
      ORDER BY next_poll_at
      FOR UPDATE SKIP LOCKED
      LIMIT 20
    )
    RETURNING m.id
  `);
  return (rows as unknown as { id: number }[]).map((r) => r.id);
}

export async function setWatermark(
  mailboxId: number,
  uidValidity: number,
  lastUid: number,
): Promise<void> {
  await db.update(teamMailbox).set({ uidValidity, lastUid }).where(eq(teamMailbox.id, mailboxId));
}

export async function markPolled(mailboxId: number): Promise<void> {
  await db
    .update(teamMailbox)
    .set({ failures: 0, lastError: null, lastPolledAt: new Date() })
    .where(eq(teamMailbox.id, mailboxId));
}

// A sign-in failure counts toward pausing the mailbox; any other error only records its
// text and is retried on the next interval.
export async function markFailed(
  box: { id: number; failures: number },
  error: string,
  authFailure: boolean,
): Promise<void> {
  const failures = authFailure ? box.failures + 1 : box.failures;
  await db
    .update(teamMailbox)
    .set({
      failures,
      lastError: error.slice(0, 500),
      status: failures >= MAX_AUTH_FAILURES ? 'paused' : 'active',
    })
    .where(eq(teamMailbox.id, box.id));
}

// Stores the attachments within the instance upload limits in the object store and only
// lists the rest. The key is not project scoped: the project is unknown until a member
// accepts the item.
async function storeAttachments(mailboxId: number, mail: ParsedMail): Promise<IntakeAttachment[]> {
  const limits = await getStorageSettings();
  const out: IntakeAttachment[] = [];
  for (const a of mail.attachments) {
    const fits =
      a.sizeBytes <= limits.maxAttachmentMb * MB &&
      mimeAllowed(a.contentType, limits.attachmentMimeTypes);
    let s3Key: string | null = null;
    if (fits) {
      const name = safeAttachmentFilename(a.filename)
        .replace(/[^\w.-]+/g, '_')
        .slice(-100);
      s3Key = `intake/${mailboxId}/${randomUUID()}-${name}`;
      await putObject(s3Key, a.content, a.contentType);
    }
    out.push({
      filename: safeAttachmentFilename(a.filename),
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      s3Key,
    });
  }
  return out;
}

// The issue an email answers: the issue of an accepted email, or of an earlier reply, of the
// same mailbox whose Message-ID is in In-Reply-To or References. Null when it answers none.
async function findRepliedIssue(mailboxId: number, mail: ParsedMail): Promise<number | null> {
  const ids = [...(mail.inReplyTo ? [mail.inReplyTo] : []), ...mail.references];
  if (ids.length === 0) return null;
  const [row] = await db
    .select({ issueId: intakeItem.issueId })
    .from(intakeItem)
    .where(
      and(
        eq(intakeItem.status, 'accepted'),
        isNotNull(intakeItem.issueId),
        inArray(intakeItem.messageId, ids),
        eq(intakeItem.teamMailboxId, mailboxId),
      ),
    )
    .orderBy(desc(intakeItem.id))
    .limit(1);
  return row?.issueId ?? null;
}

// Stores one fetched email. A message id already stored for the mailbox is skipped. Returns
// the new item's id and, for an answer to an accepted email from an allowed sender, the issue
// it is to be posted on; null for a duplicate. An email from a sender that is not allowed is
// never posted as a comment.
export async function storeMail(
  mailboxId: number,
  mail: ParsedMail,
  senderAllowed: boolean,
): Promise<{ id: number; replyToIssueId: number | null } | null> {
  const [exists] = await db
    .select({ id: intakeItem.id })
    .from(intakeItem)
    .where(and(eq(intakeItem.teamMailboxId, mailboxId), eq(intakeItem.messageId, mail.messageId)));
  if (exists) return null;
  const replyToIssueId = senderAllowed ? await findRepliedIssue(mailboxId, mail) : null;
  const attachments = await storeAttachments(mailboxId, mail);
  const [row] = await db
    .insert(intakeItem)
    .values({
      replyToIssueId,
      teamMailboxId: mailboxId,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      fromName: mail.fromName,
      fromAddress: mail.fromAddress,
      senderAllowed,
      subject: mail.subject,
      sentAt: mail.sentAt,
      body: mail.body,
      attachments,
    })
    .onConflictDoNothing()
    .returning({ id: intakeItem.id });
  if (!row) {
    await deleteObjects(attachments.flatMap((a) => (a.s3Key ? [a.s3Key] : [])));
    return null;
  }
  return { id: row.id, replyToIssueId };
}

// A rejected item is kept for 30 days and then deleted with its attachments.
export const REJECTED_RETENTION_DAYS = 30;

export async function deleteExpiredRejected(): Promise<number> {
  const rows = await db
    .delete(intakeItem)
    .where(
      and(
        eq(intakeItem.status, 'rejected'),
        sql`${intakeItem.decidedAt} < now() - make_interval(days => ${REJECTED_RETENTION_DAYS})`,
      ),
    )
    .returning({ attachments: intakeItem.attachments });
  await deleteObjects(
    rows.flatMap((r) => r.attachments.flatMap((a) => (a.s3Key ? [a.s3Key] : []))),
  );
  return rows.length;
}

// Queues the triage of a new item as a run of the mailbox's agent. The api executes it. The
// run needs a project it works in: the first active project of the mailbox's team the agent
// is a member of. Without one the item stays in the inbox with no draft and "Check again".
export async function queueTriage(
  itemId: number,
  box: { teamId: number; agentId: number },
): Promise<void> {
  const [target] = await db
    .select({ projectId: project.id })
    .from(project)
    .innerJoin(projectMember, eq(projectMember.projectId, project.id))
    .innerJoin(aiAgent, eq(aiAgent.userId, projectMember.userId))
    .where(
      and(eq(project.teamId, box.teamId), eq(aiAgent.id, box.agentId), isNull(project.archivedAt)),
    )
    .orderBy(project.id)
    .limit(1);
  if (!target) return;
  await db.insert(agentRun).values({
    agentId: box.agentId,
    projectId: target.projectId,
    trigger: 'mail_triage',
    intakeItemId: itemId,
    prompt: '',
  });
}
