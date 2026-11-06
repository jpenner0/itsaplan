import { randomUUID } from 'node:crypto';
import {
  db,
  getStorageSettings,
  intakeItem,
  mailboxFolder,
  mimeAllowed,
  MB,
  type IntakeAttachment,
} from '@repo/db';
import { deleteObjects, putObject, safeAttachmentFilename } from '@repo/storage';
import { and, eq, sql } from 'drizzle-orm';
import type { ParsedMail } from './mail-parse';

// Database side of the mail fetch: claiming due folders, the watermark and the stored items.

export const POLL_INTERVAL_SECONDS = 300;
// A folder is paused after this many sign-in failures in a row.
export const MAX_AUTH_FAILURES = 3;

export interface DueFolder {
  id: number;
  name: string;
  uidValidity: number | null;
  lastUid: number | null;
  failures: number;
  mailboxId: number;
}

// Claims the folders that are due. The claim pushes next_poll_at forward by the poll
// interval, so a second worker replica skips the folder and a crashed worker's folder
// comes back on the next interval without a recovery pass.
export async function claimDueFolders(): Promise<DueFolder[]> {
  const rows = await db.execute(sql`
    UPDATE mailbox_folder f
    SET next_poll_at = now() + make_interval(secs => ${POLL_INTERVAL_SECONDS})
    WHERE f.id IN (
      SELECT id FROM mailbox_folder
      WHERE status = 'active' AND next_poll_at <= now()
      ORDER BY next_poll_at
      FOR UPDATE SKIP LOCKED
      LIMIT 20
    )
    RETURNING f.id, f.name, f.uid_validity AS "uidValidity", f.last_uid AS "lastUid",
      f.failures, f.mailbox_id AS "mailboxId"
  `);
  return (rows as unknown as DueFolder[]).map((r) => ({
    ...r,
    uidValidity: r.uidValidity == null ? null : Number(r.uidValidity),
    lastUid: r.lastUid == null ? null : Number(r.lastUid),
  }));
}

export async function setWatermark(
  folderId: number,
  uidValidity: number,
  lastUid: number,
): Promise<void> {
  await db
    .update(mailboxFolder)
    .set({ uidValidity, lastUid })
    .where(eq(mailboxFolder.id, folderId));
}

export async function markPolled(folderId: number): Promise<void> {
  await db
    .update(mailboxFolder)
    .set({ failures: 0, lastError: null, lastPolledAt: new Date() })
    .where(eq(mailboxFolder.id, folderId));
}

// A sign-in failure counts toward pausing the folder; any other error only records its
// text and is retried on the next interval.
export async function markFailed(
  folder: DueFolder,
  error: string,
  authFailure: boolean,
): Promise<void> {
  const failures = authFailure ? folder.failures + 1 : folder.failures;
  await db
    .update(mailboxFolder)
    .set({
      failures,
      lastError: error.slice(0, 500),
      status: failures >= MAX_AUTH_FAILURES ? 'paused' : 'active',
    })
    .where(eq(mailboxFolder.id, folder.id));
}

// Stores the attachments within the instance upload limits in the object store and only
// lists the rest. The key is not project scoped: the project is unknown until a member
// accepts the item.
async function storeAttachments(
  folderIdValue: number,
  mail: ParsedMail,
): Promise<IntakeAttachment[]> {
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
      s3Key = `intake/${folderIdValue}/${randomUUID()}-${name}`;
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

// Stores one fetched email. A message id already stored for the folder is skipped.
// Returns the new item's id, or null for a duplicate.
export async function storeMail(folderIdValue: number, mail: ParsedMail): Promise<number | null> {
  const [exists] = await db
    .select({ id: intakeItem.id })
    .from(intakeItem)
    .where(and(eq(intakeItem.folderId, folderIdValue), eq(intakeItem.messageId, mail.messageId)));
  if (exists) return null;
  const attachments = await storeAttachments(folderIdValue, mail);
  const [row] = await db
    .insert(intakeItem)
    .values({
      folderId: folderIdValue,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      fromName: mail.fromName,
      fromAddress: mail.fromAddress,
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
  return row.id;
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
