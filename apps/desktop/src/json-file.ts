import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Returns the parsed file, or undefined when it is missing or not valid JSON. */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Creates the parent directory when it is missing. Throws when the write fails. */
export function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

export function removeJsonFile(path: string): void {
  rmSync(path, { force: true });
}
