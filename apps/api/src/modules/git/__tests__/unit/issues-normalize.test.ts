import { describe, expect, it } from 'bun:test';
import { githubIssue, githubIssueComment, githubLabel } from '../../issues-normalize';
import { createProviderIssue, getProviderUser, issueResult } from '../../issues-provider';

const row = {
  id: 1,
  number: 4,
  title: 'T',
  state: 'open',
  state_reason: null,
  repository_url: 'https://api.github.com/repos/acme/site',
  html_url: 'https://github.com/acme/site/issues/4',
  labels: ['plain', { name: 'bug', color: 'ff0000' }, {}],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('GitHub issue mappers', () => {
  it('maps an issue with string and object labels', () => {
    expect(githubIssue(row)).toMatchObject({
      externalId: '1',
      number: 4,
      body: '',
      state: 'open',
      stateReason: null,
      repo: 'acme/site',
      author: null,
      assignees: [],
      labels: [
        { name: 'plain', color: null },
        { name: 'bug', color: 'ff0000' },
      ],
      closedAt: null,
    });
  });

  it('maps a duplicate close to not planned', () => {
    expect(githubIssue({ ...row, state: 'closed', state_reason: 'duplicate' })).toMatchObject({
      stateReason: 'not_planned',
    });
  });

  it('filters out pull requests and malformed rows', () => {
    expect(githubIssue({ ...row, pull_request: { url: 'x' } })).toBeNull();
    expect(githubIssue({ ...row, state: 'weird' })).toBeNull();
    expect(githubIssue({ ...row, created_at: 'nope' })).toBeNull();
    expect(githubIssue(null)).toBeNull();
  });

  it('maps a comment and reads the issue number from issue_url', () => {
    const comment = {
      id: 9,
      body: 'hi',
      issue_url: 'https://api.github.com/repos/acme/site/issues/4',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(githubIssueComment(comment)).toMatchObject({ externalId: '9', issueNumber: 4 });
    expect(githubIssueComment({ ...comment, issue_url: undefined })).toBeNull();
  });

  it('rejects a label without a name', () => {
    expect(githubLabel({ color: 'fff' })).toBeNull();
  });
});

describe('issue response handling', () => {
  const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

  it('returns the issue', async () => {
    expect(await issueResult(json(row), 'acme/site', 4)).toMatchObject({
      status: 'ok',
      issue: { number: 4 },
    });
  });

  it('detects a deleted issue', async () => {
    expect(await issueResult(new Response(null, { status: 410 }), 'acme/site', 4)).toEqual({
      status: 'gone',
    });
  });

  it('detects a redirect to another repository', async () => {
    const moved = new Response(null, {
      status: 301,
      headers: { location: 'https://api.github.com/repositories/55/issues/2' },
    });
    expect(await issueResult(moved, 'acme/site', 4)).toEqual({
      status: 'moved',
      url: 'https://api.github.com/repositories/55/issues/2',
    });
  });

  it('detects an issue that reports another repository', async () => {
    const other = { ...row, repository_url: 'https://api.github.com/repos/acme/other' };
    expect(await issueResult(json(other), 'Acme/Site', 4)).toMatchObject({ status: 'moved' });
    expect(await issueResult(json(row), 'Acme/Site', 4)).toMatchObject({ status: 'ok' });
  });
});

describe('unsupported providers', () => {
  it('throws a clear error before any request', async () => {
    const input = { provider: 'gitlab', baseUrl: 'https://gitlab.com', token: 't' } as const;
    await expect(createProviderIssue(input, 'acme/site', { title: 'x' })).rejects.toThrow(
      'Issue sync is not supported for gitlab',
    );
    await expect(getProviderUser(input, '1')).rejects.toThrow('not supported');
  });
});
