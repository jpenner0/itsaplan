import { describe, expect, it } from 'bun:test';
import { stripReply } from '../../replies';

describe('stripReply', () => {
  it('keeps the new text and cuts the quoted message', () => {
    const body = [
      'Thanks, here is more.',
      '',
      'On Mon, 2 Nov 2026 at 10:00, Support <s@x.com> wrote:',
      '> old text',
      '> more',
    ].join('\n');
    expect(stripReply(body)).toBe('Thanks, here is more.');
  });

  it('handles an attribution wrapped over two lines', () => {
    const body = [
      'New info',
      '',
      'On Mon, 2 Nov 2026 at 10:00, Support',
      '<s@x.com> wrote:',
      '> old',
    ].join('\n');
    expect(stripReply(body)).toBe('New info');
  });

  it('cuts German and Outlook quote headers', () => {
    expect(stripReply('Hallo\n\nAm 02.11.2026 um 10:00 schrieb Support <s@x.com>:\n> alt')).toBe(
      'Hallo',
    );
    expect(stripReply('Hi\n\n-----Original Message-----\nFrom: a@b.c\nold')).toBe('Hi');
    expect(stripReply('Hi\n\nVon: Support <s@x.com>\nGesendet: heute\nalt')).toBe('Hi');
  });

  it('cuts the signature and a mobile footer', () => {
    expect(stripReply('Works now\n\n-- \nAnn\nACME')).toBe('Works now');
    expect(stripReply('Works now\n\nSent from my iPhone')).toBe('Works now');
  });

  it('drops quoted lines in the middle and keeps interleaved answers', () => {
    expect(stripReply('> question\nanswer')).toBe('answer');
  });

  it('returns an empty string for a pure quote', () => {
    expect(stripReply('> only quote')).toBe('');
  });
});
