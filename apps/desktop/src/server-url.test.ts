import { describe, expect, test } from 'bun:test';
import { normalizeServerUrl } from './server-url';

describe('normalizeServerUrl', () => {
  test('adds https when the scheme is missing', () => {
    expect(normalizeServerUrl('plan.example.com')).toBe('https://plan.example.com');
  });

  test('trims whitespace and strips slash, path, query and hash', () => {
    expect(normalizeServerUrl('  https://plan.example.com/app/?a=1#x  ')).toBe(
      'https://plan.example.com',
    );
  });

  test('allows http and keeps the port', () => {
    expect(normalizeServerUrl('http://plan.local:3000/')).toBe('http://plan.local:3000');
  });

  test.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)'])(
    'rejects %s',
    (input) => {
      expect(() => normalizeServerUrl(input)).toThrow();
    },
  );

  test.each(['', '   ', 'http://'])('rejects %p', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
  });
});
