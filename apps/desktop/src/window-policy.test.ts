import { describe, expect, test } from 'bun:test';
import {
  isAppPopupUrl,
  isExternalOnlyUrl,
  isNavigationAllowed,
  isPermissionAllowed,
} from './window-policy';

const SERVER = 'https://plan.example.com';

describe('isPermissionAllowed', () => {
  test('grants clipboard read and write to the instance origin', () => {
    expect(isPermissionAllowed('clipboard-read', `${SERVER}/settings/labels`, SERVER)).toBe(true);
    expect(isPermissionAllowed('clipboard-sanitized-write', `${SERVER}/`, SERVER)).toBe(true);
  });
  test('denies another origin, another port and a malformed URL', () => {
    expect(isPermissionAllowed('clipboard-read', 'https://github.com/login', SERVER)).toBe(false);
    expect(isPermissionAllowed('clipboard-read', 'https://plan.example.com:8443/', SERVER)).toBe(
      false,
    );
    expect(isPermissionAllowed('clipboard-read', 'not a url', SERVER)).toBe(false);
  });
  test('denies other permissions and a missing server URL', () => {
    expect(isPermissionAllowed('media', `${SERVER}/`, SERVER)).toBe(false);
    expect(isPermissionAllowed('notifications', `${SERVER}/`, SERVER)).toBe(false);
    expect(isPermissionAllowed('clipboard-read', `${SERVER}/`, undefined)).toBe(false);
  });
});

describe('isAppPopupUrl', () => {
  test('accepts the Trello authorize page only', () => {
    expect(isAppPopupUrl('https://trello.com/1/authorize?key=abc')).toBe(true);
    expect(isAppPopupUrl('https://trello.com/b/board')).toBe(false);
    expect(isAppPopupUrl('http://trello.com/1/authorize')).toBe(false);
    expect(isAppPopupUrl('https://trello.com.evil.test/1/authorize')).toBe(false);
  });
});

describe('isNavigationAllowed', () => {
  test('allows http and https pages, so OAuth redirects stay in the window', () => {
    expect(isNavigationAllowed('https://github.com/login/oauth/authorize?x=1')).toBe(true);
    expect(isNavigationAllowed('http://localhost:3000/')).toBe(true);
  });
  test('blocks other schemes', () => {
    expect(isNavigationAllowed('file:///etc/passwd')).toBe(false);
    expect(isNavigationAllowed('itsaplan://x')).toBe(false);
  });
  test('blocks Telegram pages, which open in the system browser', () => {
    expect(isExternalOnlyUrl('https://t.me/mybot?start=abc')).toBe(true);
    expect(isNavigationAllowed('https://t.me/mybot?start=abc')).toBe(false);
    expect(isExternalOnlyUrl('https://plan.t.me.example.com/')).toBe(false);
  });
});
