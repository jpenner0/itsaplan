import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile, removeJsonFile, writeJsonFile } from './json-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop-json-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('json-file', () => {
  test('writes into a missing directory and reads the data back', () => {
    const path = join(dir, 'missing', 'server.json');
    writeJsonFile(path, { url: 'https://plan.example.com' });
    expect(readJsonFile(path)).toEqual({ url: 'https://plan.example.com' });
  });

  test('reads a missing or invalid file as undefined', () => {
    const path = join(dir, 'server.json');
    expect(readJsonFile(path)).toBeUndefined();
    writeFileSync(path, '{');
    expect(readJsonFile(path)).toBeUndefined();
  });

  test('throws when the path cannot be written', () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, '');
    expect(() => writeJsonFile(join(blocker, 'server.json'), {})).toThrow();
  });

  test('removes a file and ignores a missing one', () => {
    const path = join(dir, 'server.json');
    writeJsonFile(path, {});
    removeJsonFile(path);
    removeJsonFile(path);
    expect(readJsonFile(path)).toBeUndefined();
  });
});
