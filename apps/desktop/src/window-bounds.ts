import type { Rectangle } from 'electron';

export interface WindowState {
  bounds: Partial<Rectangle> & Pick<Rectangle, 'width' | 'height'>;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { bounds: { width: 1280, height: 800 }, maximized: false };

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Validates a stored window state. Drops the position when it is off every work area. */
export function restoreWindowState(stored: unknown, workAreas: Rectangle[]): WindowState {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_STATE;
  const { x, y, width, height, maximized } = stored as Record<string, unknown>;
  if (!isNumber(width) || !isNumber(height) || width <= 0 || height <= 0) return DEFAULT_STATE;
  const state: WindowState = { bounds: { width, height }, maximized: maximized === true };
  if (
    isNumber(x) &&
    isNumber(y) &&
    workAreas.some((area) => intersects({ x, y, width, height }, area))
  ) {
    state.bounds = { x, y, width, height };
  }
  return state;
}
