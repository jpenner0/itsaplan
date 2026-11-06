import { describe, expect, it } from 'bun:test';
import { detectProvider } from '../../providers';

describe('repository provider events', () => {
  it('normalizes a GitLab pipeline event', () => {
    const headers = { 'x-gitlab-event': 'Pipeline Hook' };
    const provider = detectProvider(headers)!;
    expect(provider.key(headers)).toBe('gitlab');
    expect(
      provider.parse(
        {
          object_kind: 'pipeline',
          object_attributes: {
            id: 19,
            status: 'failed',
            ref: 'feature/site',
            url: 'https://gitlab.com/acme/site/-/pipelines/19',
          },
          merge_request: { iid: 7, source_branch: 'feature/site' },
          project: {
            path_with_namespace: 'acme/site',
            web_url: 'https://gitlab.com/acme/site',
          },
        },
        headers,
      ),
    ).toEqual({
      kind: 'pipeline',
      repo: 'acme/site',
      pullRequestNumber: 7,
      headSha: null,
      status: 'failed',
      url: 'https://gitlab.com/acme/site/-/pipelines/19',
    });
  });

  it('uses the GitLab merge commit SHA after a merge', () => {
    const headers = { 'x-gitlab-event': 'Merge Request Hook' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          object_kind: 'merge_request',
          object_attributes: {
            iid: 7,
            action: 'merge',
            title: 'Release',
            source_branch: 'release/production',
            target_branch: 'main',
            last_commit: { id: 'source-head' },
            merge_commit_sha: 'merge-head',
          },
          project: { path_with_namespace: 'acme/site', default_branch: 'main' },
        },
        headers,
      ),
    ).toMatchObject({ kind: 'pull_request', action: 'merged', headSha: 'merge-head' });
  });

  it('falls back to the GitLab squash commit SHA after a merge', () => {
    const headers = { 'x-gitlab-event': 'Merge Request Hook' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          object_kind: 'merge_request',
          object_attributes: {
            iid: 8,
            action: 'merge',
            title: 'Squashed release',
            source_branch: 'release/squashed',
            target_branch: 'main',
            last_commit: { id: 'source-head' },
            merge_commit_sha: null,
            squash_commit_sha: 'squash-head',
          },
          project: { path_with_namespace: 'acme/site', default_branch: 'main' },
        },
        headers,
      ),
    ).toMatchObject({ kind: 'pull_request', action: 'merged', headSha: 'squash-head' });
  });

  it('normalizes a completed GitHub check run', () => {
    const headers = { 'x-github-event': 'check_run' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          check_run: {
            id: 123,
            name: 'Test suite',
            status: 'completed',
            conclusion: 'failure',
            head_sha: 'abc123',
            details_url: 'https://github.com/acme/site/actions/runs/1',
            pull_requests: [{ number: 42 }],
            app: { id: 7 },
          },
          repository: { full_name: 'acme/site' },
        },
        headers,
      ),
    ).toEqual({
      kind: 'check',
      repo: 'acme/site',
      pullRequestNumbers: [42],
      headSha: 'abc123',
      externalId: '123',
      appId: '7',
      name: 'Test suite',
      status: 'failed',
      url: 'https://github.com/acme/site/actions/runs/1',
    });
  });

  it('keeps a queued GitHub check pending without a linked pull request', () => {
    const headers = { 'x-github-event': 'check_run' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          check_run: {
            id: 124,
            name: 'Build',
            status: 'queued',
            head_sha: 'def456',
            pull_requests: [],
          },
          repository: { full_name: 'acme/site' },
        },
        headers,
      ),
    ).toMatchObject({ kind: 'check', pullRequestNumbers: [], status: 'pending' });
  });

  it('normalizes a GitHub branch creation', () => {
    const headers = { 'x-github-event': 'create' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          ref: 'feature/MKT-42-summary',
          ref_type: 'branch',
          sha: 'abc123',
          repository: {
            full_name: 'acme/site',
            default_branch: 'main',
            html_url: 'https://github.com/acme/site',
          },
        },
        headers,
      ),
    ).toEqual({
      kind: 'branch',
      action: 'created',
      repo: 'acme/site',
      branch: 'feature/MKT-42-summary',
      url: 'https://github.com/acme/site/tree/feature/MKT-42-summary',
      headSha: 'abc123',
      defaultBranch: 'main',
    });
  });

  it('links a Forgejo branch under /src/branch/', () => {
    const headers = { 'x-forgejo-event': 'create', 'x-gitea-event': 'create' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          ref: 'feature/MKT-42-summary',
          ref_type: 'branch',
          sha: 'abc123',
          repository: { full_name: 'acme/site', html_url: 'https://git.example/acme/site' },
        },
        headers,
      ),
    ).toMatchObject({
      kind: 'branch',
      url: 'https://git.example/acme/site/src/branch/feature/MKT-42-summary',
    });
  });

  it('normalizes a new GitLab branch push', () => {
    const headers = { 'x-gitlab-event': 'Push Hook' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          object_kind: 'push',
          before: '0'.repeat(40),
          after: 'abc123',
          checkout_sha: 'abc123',
          ref: 'refs/heads/MKT-9-branch',
          project: {
            path_with_namespace: 'acme/site',
            default_branch: 'main',
            web_url: 'https://gitlab.com/acme/site',
          },
        },
        headers,
      ),
    ).toMatchObject({
      kind: 'branch',
      action: 'created',
      branch: 'MKT-9-branch',
      headSha: 'abc123',
    });
  });

  it('normalizes an explicit Bitbucket branch creation', () => {
    const headers = { 'x-event-key': 'repo:branch_created' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          branch: {
            name: 'feature/MKT-11-summary',
            target: { hash: 'def456' },
            links: { html: { href: 'https://bitbucket.org/acme/site/branch/MKT-11-summary' } },
          },
          repository: { full_name: 'acme/site', mainbranch: { name: 'main' } },
        },
        headers,
      ),
    ).toEqual({
      kind: 'branch',
      action: 'created',
      repo: 'acme/site',
      branch: 'feature/MKT-11-summary',
      url: 'https://bitbucket.org/acme/site/branch/MKT-11-summary',
      headSha: 'def456',
      defaultBranch: 'main',
    });
  });

  it('accepts the Bitbucket push-shaped branch deletion payload', () => {
    const headers = { 'x-event-key': 'repo:branch_deleted' };
    const provider = detectProvider(headers)!;
    expect(
      provider.parse(
        {
          push: {
            changes: [{ old: { type: 'branch', name: 'MKT-12-cleanup' }, new: null }],
          },
          repository: { full_name: 'acme/site', mainbranch: { name: 'main' } },
        },
        headers,
      ),
    ).toMatchObject({
      kind: 'branch',
      action: 'deleted',
      branch: 'MKT-12-cleanup',
      headSha: null,
    });
  });
});

describe('GitHub pull request actions', () => {
  const headers = { 'x-github-event': 'pull_request' };
  const parse = (action: string) =>
    detectProvider(headers)!.parse(
      {
        action,
        pull_request: { number: 7, title: 'Change', base: { ref: 'main' }, head: { ref: 'b' } },
        repository: { full_name: 'acme/site' },
      },
      headers,
    );

  it('keeps the action GitHub sent next to the folded one', () => {
    expect(parse('opened')).toMatchObject({ action: 'opened', providerAction: 'opened' });
    expect(parse('reopened')).toMatchObject({ action: 'opened', providerAction: 'reopened' });
    expect(parse('ready_for_review')).toMatchObject({
      action: 'opened',
      providerAction: 'ready_for_review',
    });
    expect(parse('synchronize')).toMatchObject({
      action: 'updated',
      providerAction: 'synchronize',
    });
    expect(parse('closed')).toMatchObject({ action: 'closed', providerAction: 'closed' });
  });

  it('ignores an action it does not handle', () => {
    expect(parse('labeled')).toBeNull();
  });
});

describe('GitHub issue events', () => {
  const repository = { full_name: 'acme/site' };
  const issue = {
    id: 900,
    number: 12,
    title: 'Broken link',
    body: null,
    state: 'closed',
    state_reason: 'not_planned',
    html_url: 'https://github.com/acme/site/issues/12',
    repository_url: 'https://api.github.com/repos/acme/site',
    user: { id: 5, login: 'octo' },
    assignees: [{ id: 6, login: 'hubot' }],
    labels: [{ name: 'bug', color: 'd73a4a' }],
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-02T10:00:00Z',
    closed_at: '2026-01-02T10:00:00Z',
  };
  const headers = { 'x-github-event': 'issues' };
  const parse = (payload: unknown, h: Record<string, string> = headers) =>
    detectProvider(h)!.parse(payload, h);

  it('normalizes a closed issue', () => {
    expect(
      parse({ action: 'closed', issue, repository, sender: { id: 5, login: 'octo' } }),
    ).toEqual({
      kind: 'issue',
      action: 'closed',
      repo: 'acme/site',
      issue: {
        externalId: '900',
        number: 12,
        title: 'Broken link',
        body: '',
        state: 'closed',
        stateReason: 'not_planned',
        url: 'https://github.com/acme/site/issues/12',
        repo: 'acme/site',
        author: { id: '5', login: 'octo' },
        assignees: [{ id: '6', login: 'hubot' }],
        labels: [{ name: 'bug', color: 'd73a4a' }],
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-02T10:00:00.000Z',
        closedAt: '2026-01-02T10:00:00.000Z',
      },
      label: null,
      assignee: null,
      transferredTo: null,
      sender: { id: '5', login: 'octo' },
    });
  });

  it('carries the label, assignee and transfer target', () => {
    expect(
      parse({ action: 'labeled', issue, repository, label: { name: 'bug', color: 'd73a4a' } }),
    ).toMatchObject({ action: 'labeled', label: { name: 'bug', color: 'd73a4a' } });
    expect(
      parse({ action: 'assigned', issue, repository, assignee: { id: 6, login: 'hubot' } }),
    ).toMatchObject({ action: 'assigned', assignee: { id: '6', login: 'hubot' } });
    expect(
      parse({
        action: 'transferred',
        issue,
        repository,
        changes: { new_repository: { full_name: 'acme/other' } },
      }),
    ).toMatchObject({ action: 'transferred', transferredTo: 'acme/other' });
  });

  it('ignores unknown actions and pull requests', () => {
    expect(parse({ action: 'pinned', issue, repository })).toBeNull();
    expect(
      parse({ action: 'opened', issue: { ...issue, pull_request: { url: 'x' } }, repository }),
    ).toBeNull();
  });

  it('ignores issue events from Gitea and Forgejo', () => {
    expect(
      parse(
        { action: 'opened', issue, repository },
        { 'x-gitea-event': 'issues', 'x-github-event': 'issues' },
      ),
    ).toBeNull();
  });

  const comment = {
    id: 77,
    body: 'Looks good',
    html_url: 'https://github.com/acme/site/issues/12#issuecomment-77',
    user: { id: 5, login: 'octo' },
    created_at: '2026-01-03T10:00:00Z',
    updated_at: '2026-01-03T11:00:00Z',
  };

  it('normalizes an issue comment', () => {
    expect(
      parse(
        { action: 'edited', issue: { number: 12 }, comment, repository },
        {
          'x-github-event': 'issue_comment',
        },
      ),
    ).toEqual({
      kind: 'issue_comment',
      action: 'edited',
      repo: 'acme/site',
      comment: {
        externalId: '77',
        issueNumber: 12,
        body: 'Looks good',
        url: 'https://github.com/acme/site/issues/12#issuecomment-77',
        author: { id: '5', login: 'octo' },
        createdAt: '2026-01-03T10:00:00.000Z',
        updatedAt: '2026-01-03T11:00:00.000Z',
      },
      sender: null,
    });
  });

  it('ignores a comment on a pull request', () => {
    expect(
      parse(
        {
          action: 'created',
          issue: { number: 3, pull_request: { url: 'x' } },
          comment,
          repository,
        },
        { 'x-github-event': 'issue_comment' },
      ),
    ).toBeNull();
  });
});
