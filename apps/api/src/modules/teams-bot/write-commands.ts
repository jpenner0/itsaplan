import { db, user } from '@repo/db';
import { sql } from 'drizzle-orm';
import { listColumns, type ColumnRow } from '#modules/columns/service';
import { createComment } from '#modules/issues/activity';
import { ISSUE_TEXT_LIMIT } from '#modules/issues/model';
import { createIssue, updateIssue, type IssueRow } from '#modules/issues/service';
import { publishNewIssue } from '#modules/issue-sync/outbound';
import { getMembership } from '#modules/members/service';
import type { ProjectRow } from '#modules/projects/service';
import { issueUrl } from '#modules/teams/ref';
import { assertPermission } from '#shared/access';
import { HttpError } from '#shared/lib';
import { parseIssueRef, parseProjectRef, type IssueRef } from './commands';
import { ambiguousReply, NOT_FOUND, resolveIssue, resolveProject } from './resolve';

// `new`, `done`, `status`, `comment` and `assign`: writes that run as the linked user
// through the same service functions as the web app, so the permission checks, the
// activity log and the live updates are the same. A failed command changes nothing and
// gets one short reply. A missing permission and a missing issue both reply `Not found.`

const TITLE_LIMIT = 500;

type Action = 'create' | 'edit';

// Runs `run` when the user holds the permission, and turns a refused permission or a
// failure of the service into the reply.
async function guarded(
  userId: string,
  project: ProjectRow,
  action: Action,
  run: () => Promise<string>,
): Promise<string> {
  try {
    await assertPermission(project.id, { id: userId }, 'work_items', action);
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) return NOT_FOUND;
    throw err;
  }
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) return err.message;
    throw err;
  }
}

function describeIssue(issue: IssueRow, project: ProjectRow, text: string): string {
  const url = issueUrl(project.teamRef, project.key, issue.sequenceNumber);
  return `${text} ${issue.identifier} ${issue.title}${url ? `\n\n${url}` : ''}`;
}

// Resolves the issue a command names and runs `run` on it.
async function withIssue(
  userId: string,
  ref: IssueRef,
  action: Action,
  run: (issue: IssueRow, project: ProjectRow) => Promise<string>,
): Promise<string> {
  const resolved = await resolveIssue(userId, ref);
  if (resolved.kind === 'none') return NOT_FOUND;
  if (resolved.kind === 'ambiguous') return ambiguousReply(resolved.projects, ref.sequenceNumber);
  const { issue, project } = resolved.value;
  return guarded(userId, project, action, () => run(issue, project));
}

export async function newIssue(userId: string, args: string): Promise<string> {
  const usage = 'Usage: new @KEY <title>, for example new @MKT Write the launch post';
  const [first, ...rest] = args.split(/\s+/);
  const ref = parseProjectRef(first);
  const title = rest.join(' ');
  if (!ref || !title) return usage;
  if (title.length > TITLE_LIMIT) return `The title is longer than ${TITLE_LIMIT} characters.`;
  const resolved = await resolveProject(userId, ref);
  if (resolved.kind === 'none') return NOT_FOUND;
  if (resolved.kind === 'ambiguous') return ambiguousReply(resolved.projects);
  const project = resolved.value;
  return guarded(userId, project, 'create', async () => {
    const [column] = await listColumns(project.id);
    if (!column) return 'The project has no columns.';
    const created = await createIssue(project, { columnId: column.id, title }, userId);
    await publishNewIssue(created.id, project.id);
    return describeIssue(created, project, 'Created');
  });
}

// `pickColumn` returns the target column id, or the reply when there is no target.
async function moveTo(
  userId: string,
  ref: IssueRef,
  pickColumn: (columns: ColumnRow[]) => number | string,
): Promise<string> {
  return withIssue(userId, ref, 'edit', async (issue, project) => {
    const columns = await listColumns(project.id);
    const picked = pickColumn(columns);
    if (typeof picked === 'string') return picked;
    const updated = await updateIssue(issue.id, { columnId: picked }, userId);
    if (!updated) return NOT_FOUND;
    const name = columns.find((c) => c.id === picked)?.name;
    return describeIssue(updated, project, `Moved to ${name}:`);
  });
}

export async function doneIssue(userId: string, args: string): Promise<string> {
  const ref = parseIssueRef(args);
  if (!ref) return 'Usage: done <id>, for example done MKT-42';
  return moveTo(userId, ref, (columns) => {
    const done = columns.find((c) => c.stateType === 'completed');
    return done ? done.id : 'This project has no column of the type completed.';
  });
}

export async function statusIssue(userId: string, args: string): Promise<string> {
  const [id, ...rest] = args.split(/\s+/);
  const ref = parseIssueRef(id);
  const name = rest.join(' ').trim().toLowerCase();
  if (!ref || !name) return 'Usage: status <id> <column>, for example status MKT-42 In Progress';
  return moveTo(userId, ref, (columns) => {
    const column = columns.find((c) => c.name.toLowerCase() === name);
    return column ? column.id : `Unknown column. Columns: ${columns.map((c) => c.name).join(', ')}`;
  });
}

export async function commentIssue(userId: string, args: string): Promise<string> {
  const match = args.match(/^(\S+)\s+([\s\S]+)$/);
  const ref = match && parseIssueRef(match[1]);
  if (!match || !ref) return 'Usage: comment <id> <text>, for example comment MKT-42 Looks good';
  if (match[2].length > ISSUE_TEXT_LIMIT) return 'The comment is too long.';
  return withIssue(userId, ref, 'edit', async (issue, project) => {
    await createComment({ issueId: issue.id, actorUserId: userId, body: match[2] });
    return describeIssue(issue, project, 'Comment added to');
  });
}

export async function assignIssue(userId: string, args: string): Promise<string> {
  const [id, who, extra] = args.split(/\s+/);
  const ref = parseIssueRef(id);
  if (!ref || !who || extra) {
    return 'Usage: assign <id> me, or assign <id> <email>, for example assign MKT-42 me';
  }
  return withIssue(userId, ref, 'edit', async (issue, project) => {
    const assigneeId = who.toLowerCase() === 'me' ? userId : await userIdByEmail(who.toLowerCase());
    // An unknown address gets the same reply as a non-member, so it does not tell
    // whether an address has an account.
    if (!assigneeId || !(await getMembership(project.id, assigneeId))) {
      return `${who} is not a member of ${project.key}.`;
    }
    const updated = await updateIssue(issue.id, { assigneeUserId: assigneeId }, userId);
    if (!updated) return NOT_FOUND;
    return describeIssue(updated, project, `Assigned to ${who}:`);
  });
}

async function userIdByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`);
  return row?.id ?? null;
}
