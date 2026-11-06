import { readableProjectIds } from '#shared/access';
import { getIssueBySequence, type IssueRow } from '#modules/issues/service';
import { listProjects, type ProjectRow } from '#modules/projects/service';
import type { IssueRef, ProjectRef } from './commands';

// Turns a reference typed in chat into a project or an issue of the linked user. Only
// non-archived projects whose work items the user may read are searched, so a project the
// user cannot reach resolves to the same `none` as one that does not exist.

export type Resolved<T> =
  { kind: 'found'; value: T } | { kind: 'none' } | { kind: 'ambiguous'; projects: ProjectRow[] };

async function accessibleProjects(userId: string): Promise<ProjectRow[]> {
  const ids = await readableProjectIds(userId, [['work_items', 'read']]);
  return ids.length ? listProjects(userId, { ids }) : [];
}

function matching(projects: ProjectRow[], ref: ProjectRef): ProjectRow[] {
  const key = ref.key.toLowerCase();
  const team = ref.team?.toLowerCase();
  return projects.filter(
    (p) => p.key.toLowerCase() === key && (!team || p.teamRef.toLowerCase() === team),
  );
}

export async function resolveProject(
  userId: string,
  ref: ProjectRef,
): Promise<Resolved<ProjectRow>> {
  const found = matching(await accessibleProjects(userId), ref);
  if (found.length === 0) return { kind: 'none' };
  if (found.length > 1) return { kind: 'ambiguous', projects: found };
  return { kind: 'found', value: found[0] };
}

export async function resolveIssue(
  userId: string,
  ref: IssueRef,
): Promise<Resolved<{ issue: IssueRow; project: ProjectRow }>> {
  const projects = await accessibleProjects(userId);
  const found = matching(projects, ref);
  if (found.length === 0) return { kind: 'none' };
  if (found.length > 1) return { kind: 'ambiguous', projects: found };
  const issue = await getIssueBySequence(found[0].id, ref.sequenceNumber);
  // An old number of a moved issue resolves to its new project, which must be reachable too.
  const project = issue && projects.find((p) => p.id === issue.projectId);
  return issue && project ? { kind: 'found', value: { issue, project } } : { kind: 'none' };
}

export const NOT_FOUND = 'Not found.';

// The reply for several matches. Nothing is changed until the user repeats the command with
// the team named; `sequenceNumber` makes the suggestions issue ids instead of project refs.
export function ambiguousReply(projects: ProjectRow[], sequenceNumber?: number): string {
  const suffix = sequenceNumber === undefined ? '' : `-${sequenceNumber}`;
  const lines = projects.map((p) => `@${p.teamRef}/${p.key}${suffix} (${p.name}, ${p.teamName})`);
  return `Several projects match. Repeat the command with the team:\n\n${lines.join('\n\n')}`;
}
