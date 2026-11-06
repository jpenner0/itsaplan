import { ImapFlow } from 'imapflow';
import { readMailboxSecret, type mailbox } from '@repo/db';
import { microsoftAccessToken } from '@repo/mailer';
import { resolveHostForConnect } from '@repo/net';

// The IMAP connection of one mailbox folder. It only reads: the folder is opened read-only
// and no message is flagged, moved or marked as read.

export interface FolderSession {
  uidValidity: number;
  // The UID the next arriving message gets. The highest UID in use is one less.
  uidNext: number;
  // The messages with a UID above `afterUid`, oldest first, at most `limit`.
  fetchAfter(afterUid: number, limit: number): Promise<{ uid: number; source: Buffer }[]>;
  close(): Promise<void>;
}

export class ImapAuthError extends Error {}

type MailboxRow = typeof mailbox.$inferSelect;

export async function openFolder(box: MailboxRow, folder: string): Promise<FolderSession> {
  const secret = readMailboxSecret(box);
  // The host is checked like any supplied URL, then the connection goes to the address that
  // was checked and keeps the host name for TLS.
  const address = await resolveHostForConnect(box.host);
  const auth =
    box.auth === 'microsoft365'
      ? {
          user: box.username,
          accessToken: await microsoftAccessToken(
            secret.oauth ?? { tenantId: '', clientId: '', clientSecret: '' },
          ),
        }
      : { user: box.username, pass: secret.password ?? '' };
  const client = new ImapFlow({
    host: address,
    port: box.port,
    secure: box.secure,
    auth,
    servername: box.host,
    tls: { servername: box.host },
    logger: false,
    socketTimeout: 60_000,
    connectionTimeout: 20_000,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    if ((err as { authenticationFailed?: boolean }).authenticationFailed) {
      throw new ImapAuthError(err instanceof Error ? err.message : 'sign-in failed');
    }
    throw err;
  }
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  const mailboxInfo = client.mailbox;
  if (!mailboxInfo) {
    lock.release();
    await client.logout().catch(() => undefined);
    throw new Error('folder could not be opened');
  }
  return {
    uidValidity: Number(mailboxInfo.uidValidity),
    uidNext: mailboxInfo.uidNext,
    async fetchAfter(afterUid, limit) {
      const out: { uid: number; source: Buffer }[] = [];
      // `n:*` always returns the last message, even when it is below `n`, so the UID is
      // checked again.
      for await (const msg of client.fetch(
        `${afterUid + 1}:*`,
        { uid: true, source: true },
        { uid: true },
      )) {
        if (msg.uid > afterUid && msg.source) out.push({ uid: msg.uid, source: msg.source });
        if (out.length >= limit) break;
      }
      return out.sort((a, b) => a.uid - b.uid);
    },
    async close() {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
}
