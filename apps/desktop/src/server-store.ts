import { readJsonFile, removeJsonFile, writeJsonFile } from './json-file';
import { normalizeServerUrl } from './server-url';

const FILE = 'server.json';

export function readServerUrl(): string | undefined {
  const data = readJsonFile(FILE);
  if (typeof data !== 'object' || data === null || !('url' in data)) return undefined;
  try {
    return normalizeServerUrl(String(data.url));
  } catch {
    return undefined;
  }
}

export function writeServerUrl(url: string): void {
  writeJsonFile(FILE, { url });
}

export function clearServerUrl(): void {
  removeJsonFile(FILE);
}
