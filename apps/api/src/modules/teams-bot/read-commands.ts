import { db, projectColumn, user } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import {
  listIssuesInProjects,
  searchIssuesInProjects,
  type CrossProjectIssueHit,
} from '#modules/issues/service';
import { readableProjectIds } from '#shared/access';
import { issueUrl } from '#modules/teams/ref';
import { parseIssueRef } from './commands';
import { ambiguousReply, NOT_FOUND, resolveIssue } from './resolve';

// `my`, `search` and `show`: reads that run as the linked user.

const LIST_LIMIT = 10;
const DESCRIPTION_LIMIT = 300;

async function columnsById(ids: number[]) {
  if (!ids.length) return new Map<number, { name: string; stateType: string }>();
  const rows = await db
    .select({ id: projectColumn.id, name: projectColumn.name, stateType: projectColumn.stateType })
    .from(projectColumn)
    .where(inArray(projectColumn.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

async function formatHits(hits: CrossProjectIssueHit[]): Promise<string> {
  const columns = await columnsById([...new Set(hits.map((h) => h.columnId))]);
  return hits
    .map((h) => {
      const url = issueUrl(h.projectRef.split('.')[0], h.projectKey, h.sequenceNumber);
      return `${h.identifier} ${h.title} (${columns.get(h.columnId)?.name ?? '?'})${url ? ` ${url}` : ''}`;
    })
    .join('\n\n');
}

export async function myIssues(userId: string): Promise<string> {
  const ids = await readableProjectIds(userId, [['work_items', 'read']]);
  const hits = await listIssuesInProjects(ids, {
    assigneeUserId: userId,
    stateTypes: ['backlog', 'unstarted', 'started'],
    limit: LIST_LIMIT,
  });
  return hits.length ? await formatHits(hits) : 'No open issues are assigned to you.';
}

export async function searchIssues(userId: string, text: string): Promise<string> {
  if (!text) return 'Usage: search <text>';
  const ids = await readableProjectIds(userId, [['work_items', 'read']]);
  const hits = await searchIssuesInProjects(
    ids,
    text,
    { limit: LIST_LIMIT, perProjectLimit: LIST_LIMIT },
    { includeArchived: false },
  );
  return hits.length ? await formatHits(hits) : 'No issues found.';
}

export async function showIssue(userId: string, args: string): Promise<string> {
  const ref = parseIssueRef(args);
  if (!ref) return 'Usage: show <id>, for example show MKT-42';
  const resolved = await resolveIssue(userId, ref);
  if (resolved.kind === 'none') return NOT_FOUND;
  if (resolved.kind === 'ambiguous') return ambiguousReply(resolved.projects, ref.sequenceNumber);
  const { issue, project } = resolved.value;
  const column = (await columnsById([issue.columnId])).get(issue.columnId);
  const [assignee] = issue.assigneeUserId
    ? await db.select({ name: user.name }).from(user).where(eq(user.id, issue.assigneeUserId))
    : [];
  // Embedded images are data URIs that would fill the shortened text.
  const description = issue.description.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
  const lines = [
    `${issue.identifier} ${issue.title}`,
    `Status: ${column?.name ?? '?'}`,
    `Assignee: ${assignee?.name ?? 'nobody'}`,
  ];
  if (description) {
    lines.push(
      description.length > DESCRIPTION_LIMIT
        ? `${description.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`
        : description,
    );
  }
  const url = issueUrl(project.teamRef, project.key, issue.sequenceNumber);
  if (url) lines.push(url);
  return lines.join('\n\n');
}
