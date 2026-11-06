import {
  agentRun,
  db,
  intakeItem,
  label,
  mailbox,
  mailboxFolder,
  project,
  projectColumn,
  type IntakeDraft,
} from '@repo/db';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { assertPermission, assertProjectWritable, checkPermission } from '#shared/access';
import { HttpError } from '#shared/lib';
import { createComment } from '#modules/issues/activity';
import { createIssue, getIssue, getIssues, updateIssue } from '#modules/issues/service';
import { getProjectById } from '#modules/projects/service';
import { moveAttachments } from './attachments';
import { withoutMentions } from './replies';
import { queueTriageRun } from './triage';

// The Mail inbox: the drafts of the emails fetched from the user's own mailboxes. Every query
// is scoped to the mailbox owner, so another user's email reads as missing.

type Item = typeof intakeItem.$inferSelect;
const SORTED_OUT = ['spam', 'no_ticket'];

interface OwnedItem {
  item: Item;
  teamId: number;
  folderName: string;
  agentId: number;
}

async function ownedItem(userId: string, itemId: number): Promise<OwnedItem> {
  const [row] = await db
    .select({
      item: intakeItem,
      teamId: mailboxFolder.teamId,
      folderName: mailboxFolder.name,
      agentId: mailboxFolder.agentId,
    })
    .from(intakeItem)
    .innerJoin(mailboxFolder, eq(mailboxFolder.id, intakeItem.folderId))
    .innerJoin(mailbox, eq(mailbox.id, mailboxFolder.mailboxId))
    .where(and(eq(intakeItem.id, itemId), eq(mailbox.userId, userId)));
  if (!row) throw new HttpError(404, 'Email not found');
  return row;
}

function assertOpen(item: Item): void {
  if (item.status !== 'new') throw new HttpError(409, 'This email was already decided');
}

// An open draft: not decided and not a reply that became a comment.
// A new email that is not a reply waiting to be posted as a comment.
const openFor = (userId: string) =>
  and(eq(mailbox.userId, userId), eq(intakeItem.status, 'new'), isNull(intakeItem.replyToIssueId));

export async function inboxCount(userId: string): Promise<{ open: number; enabled: boolean }> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(intakeItem)
    .innerJoin(mailboxFolder, eq(mailboxFolder.id, intakeItem.folderId))
    .innerJoin(mailbox, eq(mailbox.id, mailboxFolder.mailboxId))
    .where(
      and(
        openFor(userId),
        or(isNull(intakeItem.classification), notInArray(intakeItem.classification, SORTED_OUT)),
      ),
    );
  const [folder] = await db
    .select({ id: mailboxFolder.id })
    .from(mailboxFolder)
    .innerJoin(mailbox, eq(mailbox.id, mailboxFolder.mailboxId))
    .where(eq(mailbox.userId, userId))
    .limit(1);
  return { open: row?.n ?? 0, enabled: Boolean(folder) };
}

export async function listInbox(userId: string) {
  const rows = await db
    .select({
      item: intakeItem,
      teamId: mailboxFolder.teamId,
      folderName: mailboxFolder.name,
    })
    .from(intakeItem)
    .innerJoin(mailboxFolder, eq(mailboxFolder.id, intakeItem.folderId))
    .innerJoin(mailbox, eq(mailbox.id, mailboxFolder.mailboxId))
    .where(openFor(userId))
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
  const dups = new Map((await getIssues(dupIds)).map((i) => [i.id, i]));
  const dtos = rows.map(({ item, teamId, folderName }) => {
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
      folderName,
      teamId,
      triage: triageState(status),
      draft: toDraft(item.draft, draftProjects, dups),
    };
  });
  return {
    items: dtos.filter((d) => !d.classification || !SORTED_OUT.includes(d.classification)),
    sortedOut: dtos.filter((d) => d.classification && SORTED_OUT.includes(d.classification)),
  };
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

// The projects a draft can be moved to: projects of the teams of the user's folders where
// the user may create issues, with their labels.
export async function inboxProjects(userId: string) {
  const folders = await db
    .selectDistinct({ teamId: mailboxFolder.teamId })
    .from(mailboxFolder)
    .innerJoin(mailbox, eq(mailbox.id, mailboxFolder.mailboxId))
    .where(eq(mailbox.userId, userId));
  if (folders.length === 0) return [];
  const rows = await db
    .select({ id: project.id, key: project.key, name: project.name, teamId: project.teamId })
    .from(project)
    .where(
      and(
        inArray(
          project.teamId,
          folders.map((f) => f.teamId),
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
  const owned = await ownedItem(userId, itemId);
  assertOpen(owned.item);
  const target = await getProjectById(input.projectId);
  if (!target || target.teamId !== owned.teamId) {
    throw new HttpError(400, "Choose a project of the folder's team");
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
  const owned = await ownedItem(userId, itemId);
  assertOpen(owned.item);
  await db
    .update(intakeItem)
    .set({ status: 'rejected', decidedAt: new Date() })
    .where(and(eq(intakeItem.id, itemId), eq(intakeItem.status, 'new')));
}

// Attaches the email as a comment of the duplicate the agent found, or any issue of the team.
export async function commentOnIssue(userId: string, itemId: number, issueId: number) {
  const owned = await ownedItem(userId, itemId);
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
        withoutMentions(owned.item.body),
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

// Queues the triage again as a new run of the folder's agent.
export async function retriage(userId: string, itemId: number): Promise<void> {
  const owned = await ownedItem(userId, itemId);
  assertOpen(owned.item);
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
  const queued = await queueTriageRun(
    itemId,
    { agentId: owned.agentId, teamId: owned.teamId },
    userId,
  );
  if (!queued)
    throw new HttpError(400, 'The agent works in no project where you can create issues');
}
