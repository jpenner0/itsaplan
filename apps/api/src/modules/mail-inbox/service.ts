import {
  agentRun,
  db,
  intakeItem,
  label,
  project,
  projectColumn,
  teamMailbox,
  type IntakeDraft,
} from '@repo/db';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import {
  assertPermission,
  assertProjectWritable,
  checkPermission,
  getTeamAccess,
} from '#shared/access';
import { HttpError } from '#shared/lib';
import { createComment } from '#modules/issues/activity';
import { createIssue, getIssue, getIssues, updateIssue } from '#modules/issues/service';
import { getProjectById } from '#modules/projects/service';
import { listTeams } from '#modules/teams/service';
import { moveAttachments } from './attachments';
import { stripReply, withoutMentions } from './replies';
import { queueTriageRun } from './triage';

// The Mail inbox: the drafts of the emails fetched by the mailboxes of the teams the user
// belongs to. Every member of the team sees them and may decide them; for anyone else an
// email reads as missing.

type Item = typeof intakeItem.$inferSelect;
const SORTED_OUT = ['spam', 'no_ticket'];

interface VisibleItem {
  item: Item;
  teamId: number;
  agentId: number;
}

async function memberTeamIds(userId: string): Promise<number[]> {
  return (await listTeams(userId)).map((t) => t.id);
}

async function visibleItem(userId: string, itemId: number): Promise<VisibleItem> {
  const [row] = await db
    .select({ item: intakeItem, teamId: teamMailbox.teamId, agentId: teamMailbox.agentId })
    .from(intakeItem)
    .innerJoin(teamMailbox, eq(teamMailbox.id, intakeItem.teamMailboxId))
    .where(eq(intakeItem.id, itemId));
  if (!row || !(await getTeamAccess(row.teamId, userId))) {
    throw new HttpError(404, 'Email not found');
  }
  return row;
}

function assertOpen(item: Item): void {
  if (item.status !== 'new') throw new HttpError(409, 'This email was already decided');
}

const openIn = (teamIds: number[]) =>
  and(inArray(teamMailbox.teamId, teamIds), eq(intakeItem.status, 'new'));

// Not sorted out: the sender is allowed and the agent did not call it spam or no ticket.
const isTriaged = and(
  eq(intakeItem.senderAllowed, true),
  or(isNull(intakeItem.classification), notInArray(intakeItem.classification, SORTED_OUT)),
);

export async function inboxCount(userId: string): Promise<{ open: number; enabled: boolean }> {
  const teamIds = await memberTeamIds(userId);
  if (teamIds.length === 0) return { open: 0, enabled: false };
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(intakeItem)
    .innerJoin(teamMailbox, eq(teamMailbox.id, intakeItem.teamMailboxId))
    .where(and(openIn(teamIds), isTriaged));
  const [box] = await db
    .select({ id: teamMailbox.id })
    .from(teamMailbox)
    .where(inArray(teamMailbox.teamId, teamIds))
    .limit(1);
  return { open: row?.n ?? 0, enabled: Boolean(box) };
}

export async function listInbox(userId: string) {
  const teamIds = await memberTeamIds(userId);
  if (teamIds.length === 0) return { items: [], sortedOut: [] };
  const rows = await db
    .select({ item: intakeItem, teamId: teamMailbox.teamId, agentId: teamMailbox.agentId })
    .from(intakeItem)
    .innerJoin(teamMailbox, eq(teamMailbox.id, intakeItem.teamMailboxId))
    .where(openIn(teamIds))
    .orderBy(desc(intakeItem.sentAt), desc(intakeItem.id))
    .limit(200);
  const ids = rows.map((r) => r.item.id);
  const runs = ids.length
    ? await db
        .select({ itemId: agentRun.intakeItemId, status: agentRun.status })
        .from(agentRun)
        .where(inArray(agentRun.intakeItemId, ids))
        .orderBy(asc(agentRun.id))
    : [];
  const triage = new Map(runs.map((r) => [r.itemId, r.status]));
  const draftProjectIds = [
    ...new Set(rows.flatMap((r) => (r.item.draft ? [r.item.draft.projectId] : []))),
  ];
  const draftProjects = new Map(
    (draftProjectIds.length
      ? await db
          .select({ id: project.id, key: project.key, name: project.name })
          .from(project)
          .where(inArray(project.id, draftProjectIds))
      : []
    ).map((p) => [p.id, p]),
  );
  const dupIds = rows.flatMap((r) =>
    r.item.draft?.duplicateIssueId ? [r.item.draft.duplicateIssueId] : [],
  );
  const replyIds = rows.flatMap((r) => (r.item.replyToIssueId ? [r.item.replyToIssueId] : []));
  const dups = new Map((await getIssues([...dupIds, ...replyIds])).map((i) => [i.id, i]));
  const live = rows.filter((r) => !r.item.replyToIssueId || dups.has(r.item.replyToIssueId));
  // The issue of a reply was deleted after the email was stored: the email is triaged like a
  // new one.
  for (const r of rows.filter((r) => !live.includes(r))) {
    // Claimed by clearing the marker, so concurrent listings queue one run.
    const claimed = await db
      .update(intakeItem)
      .set({ replyToIssueId: null })
      .where(and(eq(intakeItem.id, r.item.id), isNotNull(intakeItem.replyToIssueId)))
      .returning({ id: intakeItem.id });
    r.item.replyToIssueId = null;
    if (claimed.length > 0) {
      await queueTriageRun(r.item.id, { agentId: r.agentId, teamId: r.teamId });
    }
  }
  const dtos = rows.map(({ item, teamId }) => {
    const replied = item.replyToIssueId ? dups.get(item.replyToIssueId) : undefined;
    const status = triage.get(item.id);
    return {
      id: item.id,
      fromName: item.fromName,
      fromAddress: item.fromAddress,
      subject: item.subject,
      sentAt: item.sentAt,
      body: item.body,
      attachments: item.attachments.map((a) => ({
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        stored: a.s3Key !== null,
      })),
      classification: item.classification as
        'bug' | 'feature' | 'question' | 'no_ticket' | 'spam' | null,
      teamId,
      replyTo: replied
        ? { id: replied.id, identifier: replied.identifier, title: replied.title }
        : null,
      triage: triageState(status),
      draft: toDraft(item.draft, draftProjects, dups),
    };
  });
  const items: typeof dtos = [];
  const sortedOut: typeof dtos = [];
  dtos.forEach((dto, i) => {
    const sorted = !rows[i]!.item.senderAllowed || SORTED_OUT.includes(dto.classification ?? '');
    (sorted ? sortedOut : items).push(dto);
  });
  return { items, sortedOut };
}

function triageState(runStatus: string | undefined): 'none' | 'pending' | 'done' | 'failed' {
  switch (runStatus) {
    case undefined:
      return 'none';
    case 'pending':
      return 'pending';
    case 'success':
      return 'done';
    default:
      return 'failed';
  }
}

function toDraft(
  draft: IntakeDraft | null,
  projects: Map<number, { id: number; key: string; name: string }>,
  dups: Map<number, { id: number; identifier: string; title: string }>,
) {
  const p = draft ? projects.get(draft.projectId) : undefined;
  if (!draft || !p) return null;
  const dup = draft.duplicateIssueId ? dups.get(draft.duplicateIssueId) : undefined;
  return {
    projectId: p.id,
    projectKey: p.key,
    projectName: p.name,
    title: draft.title,
    description: draft.description,
    labelIds: draft.labelIds,
    priority: draft.priority,
    duplicate: dup ? { id: dup.id, identifier: dup.identifier, title: dup.title } : null,
  };
}

// The projects a draft can be moved to: projects of the user's teams that have a mailbox,
// where the user may create issues, with their labels.
export async function inboxProjects(userId: string) {
  const memberIds = await memberTeamIds(userId);
  if (memberIds.length === 0) return [];
  const boxes = await db
    .select({ teamId: teamMailbox.teamId })
    .from(teamMailbox)
    .where(inArray(teamMailbox.teamId, memberIds));
  if (boxes.length === 0) return [];
  const rows = await db
    .select({ id: project.id, key: project.key, name: project.name, teamId: project.teamId })
    .from(project)
    .where(
      and(
        inArray(
          project.teamId,
          boxes.map((b) => b.teamId),
        ),
        isNull(project.archivedAt),
      ),
    )
    .orderBy(project.name);
  const allowed = [];
  for (const row of rows) {
    if (await checkPermission(row.id, { id: userId }, 'work_items', 'create')) allowed.push(row);
  }
  if (allowed.length === 0) return [];
  const labels = await db
    .select({ id: label.id, name: label.name, color: label.color, projectId: label.projectId })
    .from(label)
    .where(
      inArray(
        label.projectId,
        allowed.map((p) => p.id),
      ),
    )
    .orderBy(label.name);
  return allowed.map((p) => ({
    ...p,
    labels: labels
      .filter((l) => l.projectId === p.id)
      .map(({ id, name, color }) => ({ id, name, color })),
  }));
}

interface AcceptInput {
  projectId: number;
  title: string;
  description: string;
  labelIds: number[];
  priority: string | null;
}

// Marks an email decided with its issue and drops the raw content. The sender, the Message-ID
// and the issue stay: replies are matched against them.
async function decide(
  itemId: number,
  status: 'accepted' | 'rejected',
  issueId: number | null,
): Promise<void> {
  await db
    .update(intakeItem)
    .set({
      status,
      issueId,
      replyToIssueId: null,
      decidedAt: new Date(),
      ...(status === 'accepted' ? { body: '', attachments: [], draft: null } : {}),
    })
    .where(eq(intakeItem.id, itemId));
}

// Claims the email for one decision, so a double click cannot create two issues.
async function claim(itemId: number): Promise<void> {
  const rows = await db
    .update(intakeItem)
    .set({ status: 'accepted' })
    .where(and(eq(intakeItem.id, itemId), eq(intakeItem.status, 'new')))
    .returning({ id: intakeItem.id });
  if (rows.length === 0) throw new HttpError(409, 'This email was already decided');
}

async function release(itemId: number): Promise<void> {
  await db.update(intakeItem).set({ status: 'new' }).where(eq(intakeItem.id, itemId));
}

// The issue is created by the user who accepts it, not by the agent: their right to create
// issues in the project is checked here again.
export async function acceptItem(userId: string, itemId: number, input: AcceptInput) {
  const owned = await visibleItem(userId, itemId);
  assertOpen(owned.item);
  const target = await getProjectById(input.projectId);
  if (!target || target.teamId !== owned.teamId) {
    throw new HttpError(400, "Choose a project of the email's team");
  }
  await assertPermission(target.id, { id: userId }, 'work_items', 'create');
  await assertProjectWritable(target.id, 'POST');
  const [column] = await db
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(eq(projectColumn.projectId, target.id))
    .orderBy(asc(projectColumn.position))
    .limit(1);
  if (!column) throw new HttpError(400, 'The project has no workflow column to create issues in');
  await claim(itemId);
  try {
    const created = await createIssue(
      target,
      {
        columnId: column.id,
        title: input.title,
        description: input.description,
        priority: input.priority,
        labelIds: input.labelIds,
      },
      userId,
    );
    const notes = await moveAttachments(owned.item, target.id, created.id);
    if (notes.length > 0) {
      await updateIssue(
        created.id,
        { description: `${input.description}\n\n${notes.join('\n')}` },
        userId,
      );
    }
    await decide(itemId, 'accepted', created.id);
    return { issueId: created.id, identifier: created.identifier };
  } catch (err) {
    await release(itemId);
    throw err;
  }
}

export async function rejectItem(userId: string, itemId: number): Promise<void> {
  const owned = await visibleItem(userId, itemId);
  assertOpen(owned.item);
  await db
    .update(intakeItem)
    .set({ status: 'rejected', decidedAt: new Date() })
    .where(and(eq(intakeItem.id, itemId), eq(intakeItem.status, 'new')));
}

// Attaches the email as a comment of the duplicate the agent found, or any issue of the team.
export async function commentOnIssue(userId: string, itemId: number, issueId: number) {
  const owned = await visibleItem(userId, itemId);
  assertOpen(owned.item);
  const target = await getIssue(issueId);
  const targetProject = target ? await getProjectById(target.projectId) : null;
  if (!target || !targetProject || targetProject.teamId !== owned.teamId) {
    throw new HttpError(404, 'Issue not found');
  }
  await assertPermission(targetProject.id, { id: userId }, 'work_items', 'edit');
  await assertProjectWritable(targetProject.id, 'POST');
  await claim(itemId);
  try {
    const from = owned.item.fromName
      ? `${owned.item.fromName} <${owned.item.fromAddress}>`
      : owned.item.fromAddress;
    const notes = await moveAttachments(owned.item, targetProject.id, target.id);
    await createComment({
      issueId: target.id,
      actorUserId: userId,
      body: [
        `via email from ${from}`,
        '',
        withoutMentions(
          owned.item.replyToIssueId
            ? stripReply(owned.item.body) || owned.item.body
            : owned.item.body,
        ),
        ...(notes.length ? ['', ...notes] : []),
      ].join('\n'),
    });
    await decide(itemId, 'accepted', target.id);
    return { issueId: target.id, identifier: target.identifier };
  } catch (err) {
    await release(itemId);
    throw err;
  }
}

// Queues the triage again as a new run of the team's agent. An email from a sender that is
// not allowed is never triaged.
export async function retriage(userId: string, itemId: number): Promise<void> {
  const owned = await visibleItem(userId, itemId);
  assertOpen(owned.item);
  if (!owned.item.senderAllowed) throw new HttpError(400, 'The sender is not allowed');
  const [pending] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.intakeItemId, itemId),
        eq(agentRun.status, 'pending'),
        eq(agentRun.trigger, 'mail_triage'),
      ),
    );
  if (pending) throw new HttpError(409, 'The check is already running');
  await db.update(intakeItem).set({ replyToIssueId: null }).where(eq(intakeItem.id, itemId));
  const queued = await queueTriageRun(itemId, { agentId: owned.agentId, teamId: owned.teamId });
  if (!queued) throw new HttpError(400, 'The agent works in no project of the team');
}
