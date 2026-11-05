import { join } from 'node:path';
import { app, screen, type BrowserWindow } from 'electron';
import { readJsonFile, writeJsonFile } from './json-file';
import { restoreWindowState, type WindowState } from './window-bounds';

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

export function loadWindowState(): WindowState {
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  return restoreWindowState(readJsonFile(stateFile()), workAreas);
}

export function saveWindowStateOnClose(win: BrowserWindow): void {
  win.on('close', () => {
    try {
      writeJsonFile(stateFile(), { ...win.getNormalBounds(), maximized: win.isMaximized() });
    } catch {
      // Losing the bounds is harmless. A throw here would be an uncaught main-process exception.
    }
  });
}
