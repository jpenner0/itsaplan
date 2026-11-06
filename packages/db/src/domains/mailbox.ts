import { decryptSecret } from '@repo/crypto';
import type { MicrosoftOAuthConfig } from '@repo/mailer';
import type { mailbox } from '../schema/app';

// The decrypted sign-in of a mailbox. `password` is set for auth 'password'; `oauth` for
// 'microsoft365', where the app registration needs the IMAP.AccessAsApp permission. Read by
// the worker, which connects with it. The api owns the write, so a field added here has to
// be set there too.
export interface MailboxSecret {
  password?: string;
  oauth?: MicrosoftOAuthConfig;
}

type MailboxCiphertext = Pick<typeof mailbox.$inferSelect, 'ciphertext' | 'iv' | 'authTag'>;

export function readMailboxSecret(row: MailboxCiphertext): MailboxSecret {
  return JSON.parse(decryptSecret(row)) as MailboxSecret;
}
