// Provider-neutral issue shapes and the pure mappers from GitHub's issue JSON. The same
// mappers read REST responses and webhook payloads, which share one shape.

export interface ProviderUser {
  id: string;
  login: string;
}

export interface ProviderLabel {
  name: string;
  color: string | null;
}

export interface ProviderIssue {
  externalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  url: string | null;
  // Full name of the repository the issue belongs to now; null when the response omits it.
  repo: string | null;
  author: ProviderUser | null;
  assignees: ProviderUser[];
  labels: ProviderLabel[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ProviderIssueComment {
  externalId: string;
  issueNumber: number;
  body: string;
  url: string | null;
  author: ProviderUser | null;
  createdAt: string;
  updatedAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoText(value: unknown): string | null {
  const raw = text(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function httpUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function githubUser(value: unknown): ProviderUser | null {
  const row = record(value);
  const id = row?.id;
  const login = text(row?.login);
  if ((typeof id !== 'number' && typeof id !== 'string') || !login) return null;
  return { id: String(id), login };
}

export function githubLabel(value: unknown): ProviderLabel | null {
  if (typeof value === 'string') return value ? { name: value, color: null } : null;
  const row = record(value);
  const name = text(row?.name);
  return name ? { name, color: text(row?.color) } : null;
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

// "https://api.github.com/repos/acme/app" → "acme/app"
function repoFromApiUrl(value: unknown): string | null {
  return text(value)?.match(/\/repos\/([^/]+\/[^/]+)$/)?.[1] ?? null;
}

function trailingNumber(value: unknown): number | null {
  const match = text(value)?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function stateReason(value: unknown): ProviderIssue['stateReason'] {
  if (value === 'completed' || value === 'reopened') return value;
  // GitHub also reports "duplicate", which It's a Plan treats as not planned.
  if (value === 'not_planned' || value === 'duplicate') return 'not_planned';
  return null;
}

// Null for a pull request: GitHub serves pull requests through the issues endpoints.
export function githubIssue(value: unknown): ProviderIssue | null {
  const row = record(value);
  const id = row?.id;
  const number = row?.number;
  const createdAt = isoText(row?.created_at);
  const updatedAt = isoText(row?.updated_at);
  if (!row || row.pull_request != null) return null;
  if (typeof id !== 'number' || typeof number !== 'number' || !createdAt || !updatedAt) return null;
  if (row.state !== 'open' && row.state !== 'closed') return null;
  return {
    externalId: String(id),
    number,
    title: text(row.title) ?? '',
    body: text(row.body) ?? '',
    state: row.state,
    stateReason: stateReason(row.state_reason),
    url: httpUrl(row.html_url),
    repo: repoFromApiUrl(row.repository_url),
    author: githubUser(row.user),
    assignees: Array.isArray(row.assignees) ? compact(row.assignees.map(githubUser)) : [],
    labels: Array.isArray(row.labels) ? compact(row.labels.map(githubLabel)) : [],
    createdAt,
    updatedAt,
    closedAt: isoText(row.closed_at),
  };
}

// `issueNumber` overrides the number read from `issue_url`, which webhook payloads
// carry on the enclosing `issue` object instead.
export function githubIssueComment(
  value: unknown,
  issueNumber?: number,
): ProviderIssueComment | null {
  const row = record(value);
  const id = row?.id;
  const createdAt = isoText(row?.created_at);
  const updatedAt = isoText(row?.updated_at);
  const number = issueNumber ?? trailingNumber(row?.issue_url);
  if (typeof id !== 'number' || number === null || !createdAt || !updatedAt) return null;
  return {
    externalId: String(id),
    issueNumber: number,
    body: text(row?.body) ?? '',
    url: httpUrl(row?.html_url),
    author: githubUser(row?.user),
    createdAt,
    updatedAt,
  };
}
