import { join } from 'node:path';
import { app } from 'electron';
import { readJsonFile, removeJsonFile, writeJsonFile } from './json-file';
import { normalizeServerUrl } from './server-url';

function storeFile(): string {
  return join(app.getPath('userData'), 'server.json');
}

export function readServerUrl(): string | undefined {
  const data = readJsonFile(storeFile());
  if (typeof data !== 'object' || data === null || !('url' in data)) return undefined;
  try {
    return normalizeServerUrl(String(data.url));
  } catch {
    return undefined;
  }
}

export function writeServerUrl(url: string): void {
  writeJsonFile(storeFile(), { url });
}

export function clearServerUrl(): void {
  removeJsonFile(storeFile());
}
