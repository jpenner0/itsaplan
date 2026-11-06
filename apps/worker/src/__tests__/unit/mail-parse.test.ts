import { describe, it, expect } from 'bun:test';
import { parseMail } from '../../mail-parse';

const base = [
  'From: Ann Example <Ann@Example.com>',
  'To: support@example.com',
  'Subject: Login broken',
  'Message-ID: <abc@example.com>',
  'In-Reply-To: <prev@example.com>',
  'References: <root@example.com> <prev@example.com>',
  'Date: Tue, 03 Nov 2026 10:00:00 +0000',
];

function mail(lines: string[], body: string): Buffer {
  return Buffer.from([...base, ...lines, '', body].join('\r\n'));
}

describe('parseMail', () => {
  it('reads the headers', async () => {
    const m = await parseMail(mail(['Content-Type: text/plain'], 'Hello'));
    expect(m).toMatchObject({
      messageId: '<abc@example.com>',
      inReplyTo: '<prev@example.com>',
      references: ['<root@example.com>', '<prev@example.com>'],
      fromName: 'Ann Example',
      fromAddress: 'ann@example.com',
      subject: 'Login broken',
      body: 'Hello',
    });
  });

  it('converts an HTML body to Markdown and drops scripts', async () => {
    const m = await parseMail(
      mail(
        ['Content-Type: text/html'],
        '<p>Hi <b>there</b></p><script>alert(1)</script><ul><li>one</li></ul>',
      ),
    );
    expect(m.body).toContain('Hi **there**');
    expect(m.body).toContain('one');
    expect(m.body).not.toContain('alert');
  });

  it('derives a stable id when there is no Message-ID', async () => {
    const raw = Buffer.from('From: a@b.c\r\nSubject: x\r\n\r\nbody');
    const a = await parseMail(raw);
    const b = await parseMail(raw);
    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId).toMatch(/@no-message-id>$/);
  });

  it('ignores small inline images and keeps real attachments', async () => {
    const png = Buffer.alloc(100, 1).toString('base64');
    const pdf = Buffer.alloc(8000, 2).toString('base64');
    const raw = [
      ...base,
      'Content-Type: multipart/mixed; boundary=XX',
      '',
      '--XX',
      'Content-Type: text/plain',
      '',
      'See attached',
      '--XX',
      'Content-Type: image/png; name=pixel.png',
      'Content-Disposition: inline; filename=pixel.png',
      'Content-Transfer-Encoding: base64',
      '',
      png,
      '--XX',
      'Content-Type: application/pdf; name=report.pdf',
      'Content-Disposition: attachment; filename=report.pdf',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--XX--',
    ].join('\r\n');
    const m = await parseMail(Buffer.from(raw));
    expect(m.attachments.map((a) => a.filename)).toEqual(['report.pdf']);
    expect(m.attachments[0]!.sizeBytes).toBe(8000);
  });
});
