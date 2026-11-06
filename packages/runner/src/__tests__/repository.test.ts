import { afterEach, beforeEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Run } from '../client';
import type { RunnerConfig } from '../config';
import { handleRun } from '../tasks';

process.env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

let root: string;
let remote: string;
let reports: Record<string, unknown>[];
const original = globalThis.fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runner-repo-test-'));
  remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, seed);
  git(seed, 'checkout', '-b', 'main');
  git(seed, 'commit', '--allow-empty', '-m', 'init');
  git(seed, 'push', 'origin', 'main');
  reports = [];
  globalThis.fetch = (async (_input, init) => {
    reports.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = original;
  rmSync(root, { recursive: true, force: true });
});

const config = (command: string): RunnerConfig => ({
  name: '',
  url: 'http://plan.test',
  apiKey: 'test',
  command,
  args: [],
  env: {},
  concurrency: 1,
  pollIntervalMs: 1000,
  timeoutMs: 10_000,
  outputFormat: 'text',
});

const run = (): Run => ({
  id: 7,
  attempts: 1,
  trigger: 'delegation',
  prompt: 'Task',
  systemPrompt: '',
  issueId: 1,
  issueIdentifier: 'ABC-123',
  repository: { url: remote, baseBranch: 'main', branch: 'abc-123-fix' },
});

const result = () => reports.find((body) => 'status' in body);

it('pushes the work to the run branch and reports it', async () => {
  const cfg = config('echo hello > a.txt');
  await handleRun(cfg, new Client(cfg), () => {}, run());

  expect(result()).toMatchObject({ status: 'success', branch: 'abc-123-fix' });
  expect(git(remote, 'show', 'abc-123-fix:a.txt')).toBe('hello');
  expect(git(remote, 'log', '-1', '--format=%s', 'abc-123-fix')).toBe('ABC-123: agent changes');
});

it('reports no branch when the agent changed nothing', async () => {
  const cfg = config('true');
  await handleRun(cfg, new Client(cfg), () => {}, run());

  expect(result()).toMatchObject({ status: 'success' });
  expect(result()).not.toHaveProperty('branch');
  expect(git(remote, 'branch', '--list', 'abc-123-fix')).toBe('');
});

it('continues on the branch of an earlier delegation', async () => {
  const first = config('echo one > a.txt');
  await handleRun(first, new Client(first), () => {}, run());
  reports = [];

  const second = config('test -f a.txt && echo two > b.txt');
  await handleRun(second, new Client(second), () => {}, run());

  expect(result()).toMatchObject({ status: 'success', branch: 'abc-123-fix' });
  expect(git(remote, 'show', 'abc-123-fix:a.txt')).toBe('one');
  expect(git(remote, 'show', 'abc-123-fix:b.txt')).toBe('two');
});

it('fails the run when the repository cannot be cloned', async () => {
  const cfg = config('true');
  await handleRun(cfg, new Client(cfg), () => {}, {
    ...run(),
    repository: { url: join(root, 'missing.git'), baseBranch: 'main', branch: 'abc-123-fix' },
  });

  expect(result()).toMatchObject({ status: 'failed' });
  expect(String(result()?.error)).toContain('git clone failed');
});

it('reports no branch for a run without a repository', async () => {
  const cfg = config('true');
  await handleRun(cfg, new Client(cfg), () => {}, { ...run(), repository: null });

  expect(result()).toMatchObject({ status: 'success' });
  expect(result()).not.toHaveProperty('branch');
});
