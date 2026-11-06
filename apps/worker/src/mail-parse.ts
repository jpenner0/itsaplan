import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';
import TurndownService from 'turndown';

// Turns the raw source of one email into what the intake stores. No database and no
// network, so unit tests run without either.

// Inline images and tracking pixels below this size are noise, not attachments.
export const MIN_INLINE_IMAGE_BYTES = 5 * 1024;

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  content: Buffer;
}

export interface ParsedMail {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  fromName: string;
  fromAddress: string;
  subject: string;
  sentAt: Date | null;
  body: string;
  attachments: ParsedAttachment[];
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.remove(['script', 'style', 'head']);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

function firstAddress(from: AddressObject | undefined): { name: string; address: string } {
  const entry = from?.value[0];
  return { name: entry?.name ?? '', address: (entry?.address ?? '').toLowerCase() };
}

// Message ids are matched as plain strings, so they are stored in one form: trimmed, with
// the angle brackets the header carries.
export function normalizeMessageId(raw: string): string {
  const id = raw.trim();
  return id.startsWith('<') ? id : `<${id}>`;
}

function isNoise(contentType: string, size: number, inline: boolean): boolean {
  return inline && contentType.startsWith('image/') && size < MIN_INLINE_IMAGE_BYTES;
}

export async function parseMail(source: Buffer): Promise<ParsedMail> {
  const mail = await simpleParser(source);
  const from = firstAddress(mail.from);
  const refs = Array.isArray(mail.references)
    ? mail.references
    : mail.references
      ? [mail.references]
      : [];
  const body = mail.html ? htmlToMarkdown(mail.html) : (mail.text ?? '').trim();
  return {
    // A mail without a Message-ID still needs a stable id so a re-read does not duplicate it.
    messageId: mail.messageId
      ? normalizeMessageId(mail.messageId)
      : `<${createHash('sha256').update(source).digest('hex')}@no-message-id>`,
    inReplyTo: mail.inReplyTo ? normalizeMessageId(mail.inReplyTo) : null,
    references: refs.map(normalizeMessageId),
    fromName: from.name,
    fromAddress: from.address,
    subject: (mail.subject ?? '').trim(),
    sentAt: mail.date ?? null,
    body,
    attachments: mail.attachments
      .filter(
        (a) =>
          !isNoise(a.contentType, a.size, a.contentDisposition === 'inline' || a.related === true),
      )
      .map((a, i) => ({
        filename: a.filename ?? `attachment-${i + 1}`,
        contentType: a.contentType,
        sizeBytes: a.size,
        content: a.content,
      })),
  };
}
