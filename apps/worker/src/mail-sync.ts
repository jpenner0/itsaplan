import { db, mailbox } from '@repo/db';
import { eq } from 'drizzle-orm';
import { parseMail } from './mail-parse';
import { ImapAuthError, openFolder, type FolderSession } from './mail-imap';
import { markFailed, markPolled, setWatermark, storeMail, type DueFolder } from './mail-store';

// Messages read per poll. The rest follows on the next one.
const BATCH = 50;

// Reads the new messages of one folder. The watermark is moved after each stored message, so
// a failure half way re-reads nothing that was stored. Returns the ids of the new items.
export async function syncFolder(folder: DueFolder, session: FolderSession): Promise<number[]> {
  // The first poll, and a folder whose UIDVALIDITY changed, start at the highest UID: mail
  // that was there before is ignored.
  if (folder.uidValidity !== session.uidValidity || folder.lastUid == null) {
    await setWatermark(folder.id, session.uidValidity, session.uidNext - 1);
    return [];
  }
  const ids: number[] = [];
  const messages = await session.fetchAfter(folder.lastUid, BATCH);
  for (const message of messages) {
    const id = await storeMail(folder.id, await parseMail(message.source));
    if (id != null) ids.push(id);
    await setWatermark(folder.id, session.uidValidity, message.uid);
  }
  return ids;
}

// One poll of a claimed folder: connect, read, record the outcome.
export async function pollFolder(
  folder: DueFolder,
  open: typeof openFolder = openFolder,
): Promise<void> {
  try {
    const [box] = await db.select().from(mailbox).where(eq(mailbox.id, folder.mailboxId));
    if (!box) return;
    const session = await open(box, folder.name);
    try {
      await syncFolder(folder, session);
    } finally {
      await session.close();
    }
    await markPolled(folder.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mail] folder ${folder.id} failed: ${message}`);
    await markFailed(folder, message, err instanceof ImapAuthError);
  }
}
