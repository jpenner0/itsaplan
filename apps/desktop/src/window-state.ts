import { screen, type BrowserWindow } from 'electron';
import { readJsonFile, writeJsonFile } from './json-file';
import { restoreWindowState, type WindowState } from './window-bounds';

const FILE = 'window-state.json';

export function loadWindowState(): WindowState {
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  return restoreWindowState(readJsonFile(FILE), workAreas);
}

export function saveWindowStateOnClose(win: BrowserWindow): void {
  win.on('close', () => {
    writeJsonFile(FILE, { ...win.getNormalBounds(), maximized: win.isMaximized() });
  });
}
