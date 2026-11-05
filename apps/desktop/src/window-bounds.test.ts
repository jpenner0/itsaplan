import { describe, expect, test } from 'bun:test';
import { restoreWindowState } from './window-bounds';

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1080 }];

describe('restoreWindowState', () => {
  test('keeps a position on a display', () => {
    const stored = { x: 100, y: 50, width: 1000, height: 700, maximized: true };
    expect(restoreWindowState(stored, SCREEN)).toEqual({
      bounds: { x: 100, y: 50, width: 1000, height: 700 },
      maximized: true,
    });
  });

  test('drops a position off every display and keeps the size', () => {
    const stored = { x: 3000, y: 50, width: 1000, height: 700 };
    expect(restoreWindowState(stored, SCREEN)).toEqual({
      bounds: { width: 1000, height: 700 },
      maximized: false,
    });
  });

  test('keeps a position on a second display', () => {
    const displays = [...SCREEN, { x: 1920, y: 0, width: 1920, height: 1080 }];
    const stored = { x: 3000, y: 50, width: 1000, height: 700 };
    expect(restoreWindowState(stored, displays).bounds).toEqual(stored);
  });

  test.each([undefined, null, 'x', {}, { width: -1, height: 700 }, { width: '1000', height: 700 }])(
    'falls back to the default for %p',
    (stored) => {
      expect(restoreWindowState(stored, SCREEN)).toEqual({
        bounds: { width: 1280, height: 800 },
        maximized: false,
      });
    },
  );
});
