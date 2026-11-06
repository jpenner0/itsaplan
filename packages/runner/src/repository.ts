import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunRepository } from './client';

// A run that comes with a repository is carried out in a fresh clone of it. The clone and
// the push use the git credentials of the machine the runner is on (an SSH key, `gh auth`
// or a credential helper), so the instance's own token never reaches the runner. The
// instance opens the pull request from the branch reported here.

const exec = promisify(execFile);
const GIT_OUTPUT_LIMIT = 10 * 1024 * 1024;
const ERROR_LIMIT = 400;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      // A missing credential has to fail the run, not wait for a prompt nobody sees.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: GIT_OUTPUT_LIMIT,
    });
    return stdout.trim();
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(
      `git ${args[0]} failed: ${(stderr ?? String(error)).trim().slice(-ERROR_LIMIT)}`,
    );
  }
}

export interface Clone {
  dir: string;
  // Where the branch stood before the agent worked, to tell whether it added anything.
  start: string;
}

// Clones the base branch and checks out the run's branch. A branch that exists already
// from an earlier delegation is continued, not started over.
export async function prepareClone(repository: RunRepository): Promise<Clone> {
  const dir = await mkdtemp(join(tmpdir(), 'itsaplan-run-'));
  try {
    await git(dir, ['clone', '--branch', repository.baseBranch, '--', repository.url, '.']);
    const existing = await git(dir, ['ls-remote', '--heads', 'origin', repository.branch]);
    if (existing) {
      await git(dir, ['fetch', 'origin', repository.branch]);
      await git(dir, ['checkout', '-B', repository.branch, 'FETCH_HEAD']);
    } else {
      await git(dir, ['checkout', '-b', repository.branch]);
    }
    return { dir, start: await git(dir, ['rev-parse', 'HEAD']) };
  } catch (error) {
    await discardClone(dir);
    throw error;
  }
}

// Commits what the agent left uncommitted and pushes the branch. Returns false when the
// agent changed nothing, so no branch is reported and no pull request is opened.
export async function pushWork(
  clone: Clone,
  repository: RunRepository,
  message: string,
): Promise<boolean> {
  if (await git(clone.dir, ['status', '--porcelain'])) {
    await git(clone.dir, ['add', '--all']);
    await git(clone.dir, ['commit', '--message', message]);
  }
  if ((await git(clone.dir, ['rev-parse', 'HEAD'])) === clone.start) return false;
  await git(clone.dir, ['push', 'origin', `HEAD:refs/heads/${repository.branch}`]);
  return true;
}

export async function discardClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// What the agent is told about its working copy, added to the run's system prompt.
export function repositoryPrompt(repository: RunRepository): string {
  return (
    `## Repository\nYou work in a clone of ${repository.url} on the branch ${repository.branch}, ` +
    `created from ${repository.baseBranch}. Implement the issue here and commit your work, or ` +
    'leave it uncommitted. Do not push and do not open a pull request: the runner pushes the ' +
    'branch and the instance opens the pull request.\n'
  );
}
