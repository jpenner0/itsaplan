import { describe, expect, it } from 'bun:test';
import { UrlNotAllowedError } from '../index';
import { assertTeamsWebhookUrl, buildTeamsPayload } from '../teams-webhook';

describe('assertTeamsWebhookUrl', () => {
  it.each([
    'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x',
    'https://abc.1a.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/1/triggers/manual/paths/invoke?sig=x',
  ])('accepts %s', (raw) => {
    expect(assertTeamsWebhookUrl(raw).protocol).toBe('https:');
  });

  it.each([
    'http://prod-12.westus.logic.azure.com/workflows/abc',
    'https://example.com/workflows/abc',
    'https://logic.azure.com.evil.com/workflows/abc',
    'https://evil.com/.logic.azure.com',
    'https://user:pw@prod-12.westus.logic.azure.com/x',
    'https://prod-12.westus.logic.azure.com:8443/x',
    'https://outlook.office.com/webhook/abc',
    'not a url',
  ])('rejects %s', (raw) => {
    expect(() => assertTeamsWebhookUrl(raw)).toThrow(UrlNotAllowedError);
  });
});

describe('buildTeamsPayload', () => {
  it('wraps one Adaptive Card with an Open action', () => {
    const body = buildTeamsPayload({
      title: 'IAP-1: assigned to you',
      text: 'Body',
      url: 'https://x.test/i',
    });
    const card = body.attachments[0]!.content;
    expect(body.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.type).toBe('AdaptiveCard');
    expect(card.body[0]).toMatchObject({ text: 'IAP-1: assigned to you' });
    expect(card.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'Open', url: 'https://x.test/i' },
    ]);
  });

  it('omits the action without a url', () => {
    const card = buildTeamsPayload({ title: 't', text: 'b' }).attachments[0]!.content;
    expect('actions' in card).toBe(false);
  });
});
