import { intakeItem, type IntakeAttachment } from '@repo/db';
import { deleteObjects, getObject, putObject, attachmentObjectKey } from '@repo/storage';
import { createAttachment } from '#modules/attachments/service';

type Item = Pick<typeof intakeItem.$inferSelect, 'attachments'>;

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;

// Moves the stored attachments of an email to the issue and deletes them from the intake
// area. The ones that were too large or of a type the instance does not allow were only
// listed; so is one the project cannot take (its quota). Returns the lines that name them,
// for the description or the comment.
export async function moveAttachments(
  item: Item,
  projectId: number,
  issueId: number,
): Promise<string[]> {
  const notStored: IntakeAttachment[] = [];
  for (const a of item.attachments) {
    if (!a.s3Key) {
      notStored.push(a);
      continue;
    }
    try {
      const { body } = await getObject(a.s3Key);
      const key = attachmentObjectKey(projectId, 'attachments', issueId, a.filename);
      await putObject(key, Buffer.from(await new Response(body).arrayBuffer()), a.contentType);
      await createAttachment({
        projectId,
        issueId,
        s3Key: key,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      });
    } catch (err) {
      console.error(`[mail-inbox] attachment ${a.filename} not moved:`, err);
      notStored.push(a);
    }
  }
  await deleteObjects(item.attachments.flatMap((a) => (a.s3Key ? [a.s3Key] : [])));
  return notStored.map((a) => `Attachment not stored: ${a.filename} (${formatSize(a.sizeBytes)})`);
}
