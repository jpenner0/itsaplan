import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

function userDataFile(name: string): string {
  return join(app.getPath('userData'), name);
}

/** Returns the parsed file, or undefined when it is missing or not valid JSON. */
export function readJsonFile(name: string): unknown {
  try {
    return JSON.parse(readFileSync(userDataFile(name), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJsonFile(name: string, data: unknown): void {
  writeFileSync(userDataFile(name), JSON.stringify(data));
}

export function removeJsonFile(name: string): void {
  rmSync(userDataFile(name), { force: true });
}
