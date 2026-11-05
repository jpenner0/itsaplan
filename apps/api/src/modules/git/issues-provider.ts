import { HttpError } from '#shared/lib';
import {
  githubRepoPath,
  providerRequest,
  type ProviderConnectionInput,
} from './connections-provider';
import {
  githubIssue,
  githubIssueComment,
  githubLabel,
  githubUser,
  type ProviderIssue,
  type ProviderIssueComment,
  type ProviderLabel,
  type ProviderUser,
} from './issues-normalize';

export type {
  ProviderIssue,
  ProviderIssueComment,
  ProviderLabel,
  ProviderUser,
} from './issues-normalize';

// Issue sync through a team's personal access token. Only GitHub is implemented; the
// signatures and result types are provider-neutral so another provider can follow.

// An issue read or write has three outcomes besides an error. `gone`: the issue was
// deleted (410). `moved`: GitHub redirects to another repository (301) or the issue
// reports a different repository than the one asked. `url` is where it went, when known.
// A renamed repository redirects the same way, so the caller re-resolves a moved issue.
export type IssueResult =
  | { status: 'ok'; issue: ProviderIssue }
  | { status: 'gone' }
  | { status: 'moved'; url: string | null };

export interface CreateProviderIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface UpdateProviderIssueInput {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  // Only sent with state "closed".
  stateReason?: 'completed' | 'not_planned';
  // Replaces the whole label set.
  labels?: string[];
}

const PAGE_SIZE = 100;

function ensureGithub(input: ProviderConnectionInput): void {
  if (input.provider !== 'github') {
    throw new HttpError(400, `Issue sync is not supported for ${input.provider}`);
  }
}

function invalid(what: string): HttpError {
  return new HttpError(502, `GitHub returned an invalid ${what}`);
}

async function listAll<T>(
  input: ProviderConnectionInput,
  path: string,
  query: URLSearchParams,
  map: (value: unknown) => T | null,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    query.set('per_page', String(PAGE_SIZE));
    query.set('page', String(page));
    const response = await providerRequest(input, `${path}?${query}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw invalid('list');
    for (const row of rows) {
      const item = map(row);
      if (item) items.push(item);
    }
    if (!response.headers.get('link')?.includes('rel="next"')) return items;
  }
}

export async function issueResult(
  response: Response,
  repository: string,
  number: number,
): Promise<IssueResult> {
  if (response.status === 410) return { status: 'gone' };
  if (response.status === 301 || response.status === 302 || response.status === 307) {
    return { status: 'moved', url: response.headers.get('location') };
  }
  const body: unknown = await response.json();
  const issue = githubIssue(body);
  if (!issue || issue.number !== number) throw invalid('issue');
  if (issue.repo && issue.repo.toLowerCase() !== repository.toLowerCase()) {
    return { status: 'moved', url: issue.url };
  }
  return { status: 'ok', issue };
}

const ISSUE_STATUSES = [301, 302, 307, 410];

export async function listProviderIssuesSince(
  input: ProviderConnectionInput,
  repository: string,
  since: Date,
): Promise<ProviderIssue[]> {
  ensureGithub(input);
  return listAll(
    input,
    `${githubRepoPath(repository)}/issues`,
    new URLSearchParams({ state: 'all', since: since.toISOString() }),
    githubIssue,
  );
}

export async function listProviderOpenIssues(
  input: ProviderConnectionInput,
  repository: string,
): Promise<ProviderIssue[]> {
  ensureGithub(input);
  return listAll(
    input,
    `${githubRepoPath(repository)}/issues`,
    new URLSearchParams({ state: 'open' }),
    githubIssue,
  );
}

export async function getProviderIssue(
  input: ProviderConnectionInput,
  repository: string,
  number: number,
): Promise<IssueResult> {
  ensureGithub(input);
  const response = await providerRequest(input, `${githubRepoPath(repository)}/issues/${number}`, {
    tolerate: ISSUE_STATUSES,
  });
  return issueResult(response, repository, number);
}

export async function createProviderIssue(
  input: ProviderConnectionInput,
  repository: string,
  values: CreateProviderIssueInput,
): Promise<ProviderIssue> {
  ensureGithub(input);
  const response = await providerRequest(input, `${githubRepoPath(repository)}/issues`, {
    method: 'POST',
    body: JSON.stringify(values),
  });
  const issue = githubIssue(await response.json());
  if (!issue) throw invalid('issue');
  return issue;
}

export async function updateProviderIssue(
  input: ProviderConnectionInput,
  repository: string,
  number: number,
  values: UpdateProviderIssueInput,
): Promise<IssueResult> {
  ensureGithub(input);
  const { stateReason, ...rest } = values;
  const response = await providerRequest(input, `${githubRepoPath(repository)}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...rest,
      ...(values.state === 'closed' && stateReason ? { state_reason: stateReason } : {}),
    }),
    tolerate: ISSUE_STATUSES,
  });
  return issueResult(response, repository, number);
}

export async function addProviderIssueAssignees(
  input: ProviderConnectionInput,
  repository: string,
  number: number,
  logins: string[],
): Promise<ProviderIssue> {
  ensureGithub(input);
  const response = await providerRequest(
    input,
    `${githubRepoPath(repository)}/issues/${number}/assignees`,
    { method: 'POST', body: JSON.stringify({ assignees: logins }) },
  );
  const issue = githubIssue(await response.json());
  if (!issue) throw invalid('issue');
  return issue;
}

// Comments of every issue in the repository, oldest first. Pull request comments are
// included: the list does not say which kind an `issue_url` points to.
export async function listProviderIssueComments(
  input: ProviderConnectionInput,
  repository: string,
  since?: Date,
): Promise<ProviderIssueComment[]> {
  ensureGithub(input);
  const query = new URLSearchParams({ sort: 'created', direction: 'asc' });
  if (since) query.set('since', since.toISOString());
  return listAll(input, `${githubRepoPath(repository)}/issues/comments`, query, (row) =>
    githubIssueComment(row),
  );
}

export async function createProviderIssueComment(
  input: ProviderConnectionInput,
  repository: string,
  issueNumber: number,
  body: string,
): Promise<ProviderIssueComment> {
  ensureGithub(input);
  const response = await providerRequest(
    input,
    `${githubRepoPath(repository)}/issues/${issueNumber}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  );
  const comment = githubIssueComment(await response.json(), issueNumber);
  if (!comment) throw invalid('comment');
  return comment;
}

export async function updateProviderIssueComment(
  input: ProviderConnectionInput,
  repository: string,
  commentId: string,
  body: string,
): Promise<ProviderIssueComment> {
  ensureGithub(input);
  const response = await providerRequest(
    input,
    `${githubRepoPath(repository)}/issues/comments/${encodeURIComponent(commentId)}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
  );
  const comment = githubIssueComment(await response.json());
  if (!comment) throw invalid('comment');
  return comment;
}

// A comment that is already gone is not an error.
export async function deleteProviderIssueComment(
  input: ProviderConnectionInput,
  repository: string,
  commentId: string,
): Promise<void> {
  ensureGithub(input);
  await providerRequest(
    input,
    `${githubRepoPath(repository)}/issues/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' },
  );
}

export async function listProviderLabels(
  input: ProviderConnectionInput,
  repository: string,
): Promise<ProviderLabel[]> {
  ensureGithub(input);
  return listAll(input, `${githubRepoPath(repository)}/labels`, new URLSearchParams(), githubLabel);
}

// `color` is a hex code without "#".
export async function createProviderLabel(
  input: ProviderConnectionInput,
  repository: string,
  name: string,
  color: string,
): Promise<ProviderLabel> {
  ensureGithub(input);
  const response = await providerRequest(input, `${githubRepoPath(repository)}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name, color }),
  });
  const label = githubLabel(await response.json());
  if (!label) throw invalid('label');
  return label;
}

// Reads a user by the numeric account id. Null when the id does not exist.
export async function getProviderUser(
  input: ProviderConnectionInput,
  accountId: string,
): Promise<ProviderUser | null> {
  ensureGithub(input);
  if (!/^\d+$/.test(accountId)) throw new HttpError(400, 'Invalid GitHub account id');
  const response = await providerRequest(input, `/user/${accountId}`, { allowMissing: true });
  if (response.status === 404) return null;
  const user = githubUser(await response.json());
  if (!user) throw invalid('user');
  return user;
}
