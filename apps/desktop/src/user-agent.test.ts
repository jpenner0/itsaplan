import { describe, expect, test } from 'bun:test';
import { cleanUserAgent } from './user-agent';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.65 Safari/537.36';

describe('cleanUserAgent', () => {
  test.each(["It's a Plan/1.10.0", 'desktop/1.10.0'])(
    'removes the %s and Electron tokens',
    (app) => {
      const electron =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        `${app} Chrome/146.0.7680.65 Electron/41.10.7 Safari/537.36`;
      expect(cleanUserAgent(electron)).toBe(CHROME);
    },
  );

  test('keeps a plain Chrome user agent', () => {
    expect(cleanUserAgent(CHROME)).toBe(CHROME);
  });
});
