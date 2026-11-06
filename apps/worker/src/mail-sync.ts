import { db, teamMailbox } from '@repo/db';
import { eq } from 'drizzle-orm';
import { parseMail } from './mail-parse';
import { isSenderListed } from './mail-auth';
import { ImapAuthError, openInbox, type MailboxRow, type MailSession } from './mail-imap';
import { markFailed, markPolled, queueTriage, setWatermark, storeMail } from './mail-store';

// Messages read per poll. The rest follows on the next one.
const BATCH = 50;

// Reads the new messages of INBOX. The watermark is moved after each stored message, so a
// failure half way re-reads nothing that was stored. Returns the ids of the new items.
export async function syncMailbox(box: MailboxRow, session: MailSession): Promise<number[]> {
  // The first poll, and a mailbox whose UIDVALIDITY changed, start at the highest UID: mail
  // that was there before is ignored.
  if (box.uidValidity !== session.uidValidity || box.lastUid == null) {
    await setWatermark(box.id, session.uidValidity, session.uidNext - 1);
    return [];
  }
  const ids: number[] = [];
  const messages = await session.fetchAfter(box.lastUid, BATCH);
  for (const message of messages) {
    const mail = await parseMail(message.source);
    const senderAllowed =
      mail.authenticated && isSenderListed(box.allowedSenders, mail.fromAddress);
    const stored = await storeMail(box.id, mail, senderAllowed);
    if (stored) {
      ids.push(stored.id);
      // An answer to an accepted email is posted as a comment by the api, with no triage.
      // An email from a sender that is not allowed is only stored.
      if (senderAllowed && stored.replyToIssueId == null) await queueTriage(stored.id, box);
    }
    await setWatermark(box.id, session.uidValidity, message.uid);
  }
  return ids;
}

// One poll of a claimed mailbox: connect, read, record the outcome.
export async function pollMailbox(id: number, open: typeof openInbox = openInbox): Promise<void> {
  const [box] = await db.select().from(teamMailbox).where(eq(teamMailbox.id, id));
  if (!box) return;
  try {
    const session = await open(box);
    try {
      await syncMailbox(box, session);
    } finally {
      await session.close();
    }
    await markPolled(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mail] mailbox ${id} failed: ${message}`);
    await markFailed(box, message, err instanceof ImapAuthError);
  }
}
