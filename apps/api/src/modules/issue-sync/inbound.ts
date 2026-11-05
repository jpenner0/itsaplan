import {
  account,
  db,
  gitProviderConnection,
  issue,
  issueActivity,
  issueCommentSyncLink,
  issueDevelopmentLink,
  issueLabel,
  issueSyncLink,
  label,
  projectColumn,
  user,
} from '@repo/db';
import { and, asc, desc, eq, inArray, isNull, notInArray, type SQL } from 'drizzle-orm';
import { createIssue, setIssueLabels, updateIssue, type IssuePatch } from '#modules/issues/service';
import {
  createComment,
  deleteComment,
  updateComment,
  type ActivityActor,
} from '#modules/issues/activity';
import { queueEventRuns } from '#modules/agents/schedules/issue-runs';
import { createLabel } from '#modules/labels/service';
import { getMembership } from '#modules/members/service';
import { getProjectById } from '#modules/projects/service';
import type { ProviderConnectionInput } from '#modules/git/connections-provider';
import type {
  ProviderIssue,
  ProviderIssueComment,
  ProviderLabel,
} from '#modules/git/issues-provider';
import {
  SYNC_FIELDS,
  commentHash,
  fieldHashes,
  labelKey,
  normalizeDescription,
  providerStatus,
  stateHash,
  stateTypeStatus,
  stripCommentHeader,
  type FieldHashes,
  type SyncField,
  type SyncFields,
  type SyncStatus,
} from './normalize';

// Applies the provider's issues and comments to It's a Plan. Every write goes through
// the issue and comment services, so activity, revisions, webhooks and notifications
// follow as for a user's change. The caller runs it inside runAsIssueSync.

export interface SyncRepository {
  id: number;
  projectId: number;
  connectionId: number;
  fullName: string;
  webUrl: string;
  // The watermark when the repository was loaded, inside its lock. Null until the first
  // import has finished.
  issuesWatermark: Date | null;
  input: ProviderConnectionInput;
}

const ACTOR: ActivityActor = { system: 'GitHub' };

const CLOSED_STATE_TYPES = ['completed', 'canceled'];

// The activity actions that record a local change of each field, for last write wins.
const FIELD_ACTIONS: Record<SyncField, string[]> = {
  title: ['title'],
  description: ['description'],
  status: ['status'],
  labels: ['label_add', 'label_remove'],
  assignee: ['assignee'],
};

const STATUS_STATE_TYPE: Record<SyncStatus, string> = {
  open: 'unstarted',
  completed: 'completed',
  not_planned: 'canceled',
};

interface LocalIssue {
  id: number;
  projectId: number;
  stateType: string;
  fields: SyncFields;
}

// The issue's synced fields as It's a Plan holds them. Null when the issue is gone.
export async function localSyncFields(issueId: number): Promise<LocalIssue | null> {
  const [row] = await db
    .select({
      projectId: issue.projectId,
      title: issue.title,
      description: issue.description,
      assignee: issue.assigneeUserId,
      stateType: projectColumn.stateType,
    })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(eq(issue.id, issueId));
  if (!row) return null;
  const labels = await db
    .select({ name: label.name })
    .from(issueLabel)
    .innerJoin(label, eq(label.id, issueLabel.labelId))
    .where(eq(issueLabel.issueId, issueId));
  return {
    id: issueId,
    projectId: row.projectId,
    stateType: row.stateType,
    fields: {
      title: row.title,
      description: row.description,
      status: stateTypeStatus(row.stateType),
      labels: labels.map((item) => item.name),
      assignee: row.assignee,
    },
  };
}

// Project members by their linked provider account id.
async function linkedMembers(
  projectId: number,
  accountIds: string[],
): Promise<Map<string, string>> {
  const members = new Map<string, string>();
  if (accountIds.length === 0) return members;
  const rows = await db
    .select({ accountId: account.accountId, userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, 'github'), inArray(account.accountId, accountIds)));
  for (const row of rows) {
    if (await getMembership(projectId, row.userId)) members.set(row.accountId, row.userId);
  }
  return members;
}

export async function providerFields(
  projectId: number,
  external: ProviderIssue,
): Promise<SyncFields> {
  const members = await linkedMembers(
    projectId,
    external.assignees.map((assignee) => assignee.id),
  );
  const assignee = external.assignees.find((item) => members.has(item.id));
  return {
    title: external.title.trim(),
    description: normalizeDescription(external.body),
    status: providerStatus(external.state, external.stateReason),
    labels: external.labels.map((item) => item.name),
    assignee: assignee ? members.get(assignee.id)! : null,
  };
}

// The first column of the status's state type. An open issue falls back to the first
// open column when the project has no unstarted column.
async function statusColumnId(projectId: number, status: SyncStatus): Promise<number | null> {
  const first = async (condition: SQL) => {
    const [row] = await db
      .select({ id: projectColumn.id })
      .from(projectColumn)
      .where(and(eq(projectColumn.projectId, projectId), condition))
      .orderBy(asc(projectColumn.position))
      .limit(1);
    return row?.id ?? null;
  };
  const id = await first(eq(projectColumn.stateType, STATUS_STATE_TYPE[status]));
  if (id !== null || status !== 'open') return id;
  return first(notInArray(projectColumn.stateType, CLOSED_STATE_TYPES));
}

// The project's labels for the provider's labels, by name. A missing one is created
// with the provider's colour.
async function labelIds(projectId: number, labels: ProviderLabel[]): Promise<number[]> {
  const existing = await db
    .select({ id: label.id, name: label.name })
    .from(label)
    .where(eq(label.projectId, projectId))
    .orderBy(asc(label.id));
  const byKey = new Map<string, number>();
  for (const row of existing)
    if (!byKey.has(labelKey(row.name))) byKey.set(labelKey(row.name), row.id);
  const ids: number[] = [];
  for (const item of labels) {
    let id = byKey.get(labelKey(item.name));
    if (id === undefined) {
      const color = item.color && /^[0-9a-f]{6}$/i.test(item.color) ? `#${item.color}` : undefined;
      id = (await createLabel({ projectId, name: item.name.trim(), color })).id;
      byKey.set(labelKey(item.name), id);
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

export async function localChangedAt(issueId: number, field: SyncField): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: issueActivity.createdAt })
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.issueId, issueId),
        eq(issueActivity.kind, 'activity'),
        inArray(issueActivity.action, FIELD_ACTIONS[field]),
      ),
    )
    .orderBy(desc(issueActivity.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

export async function upsertIssueLink(
  repo: SyncRepository,
  issueId: number,
  external: ProviderIssue,
) {
  const values = {
    number: external.number,
    title: external.title,
    url: external.url,
    state: external.state,
    updatedAt: new Date(),
  };
  await db
    .insert(issueDevelopmentLink)
    .values({
      issueId,
      provider: 'github',
      repository: repo.fullName,
      kind: 'issue',
      externalKey: `issue:${external.number}`,
      targetBranch: '',
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        issueDevelopmentLink.issueId,
        issueDevelopmentLink.provider,
        issueDevelopmentLink.repository,
        issueDevelopmentLink.externalKey,
      ],
      set: values,
    });
}

async function importIssue(repo: SyncRepository, external: ProviderIssue): Promise<void> {
  const project = await getProjectById(repo.projectId);
  const columnId = project && (await statusColumnId(project.id, 'open'));
  if (!project || columnId == null) return;
  const fields = await providerFields(project.id, external);
  const created = await createIssue(
    project,
    {
      columnId,
      title: fields.title || `#${external.number}`,
      description: fields.description,
      assigneeUserId: fields.assignee,
      labelIds: await labelIds(project.id, external.labels),
    },
    ACTOR,
  );
  const hashes = fieldHashes(fields);
  await db.insert(issueSyncLink).values({
    issueId: created.id,
    managedRepositoryId: repo.id,
    externalId: external.externalId,
    externalNumber: external.number,
    externalUrl: external.url ?? `${repo.webUrl}/issues/${external.number}`,
    syncedHash: stateHash(hashes),
    fieldHashes: hashes,
    externalUpdatedAt: new Date(external.updatedAt),
  });
  await upsertIssueLink(repo, created.id, external);
  if (isNewOnProvider(repo, external)) {
    await queueEventRuns({
      type: 'synced_issue_created',
      projectId: project.id,
      issueId: created.id,
      lead: triageLead(repo, created.identifier, external.number),
    });
  }
}

// An issue created on the provider after the last sync. The first import brings in
// every open issue, and a later import can bring in an old one, such as a reopened
// issue: neither starts a triage run.
function isNewOnProvider(repo: SyncRepository, external: ProviderIssue): boolean {
  return (
    repo.issuesWatermark !== null && Date.parse(external.createdAt) > repo.issuesWatermark.getTime()
  );
}

// Carries no text from the provider's issue: the agent reads it with get_issue.
function triageLead(repo: SyncRepository, identifier: string, number: number): string {
  return (
    `Work item ${identifier} was created on GitHub ` +
    `(${repo.fullName}#${number}, ${repo.webUrl}/issues/${number}). ` +
    'Triage it: set labels and priority, link duplicates. ' +
    'Do not close it or move it to a completed or canceled column.'
  );
}

async function findLink(repo: SyncRepository, number: number) {
  const [link] = await db
    .select()
    .from(issueSyncLink)
    .where(
      and(eq(issueSyncLink.managedRepositoryId, repo.id), eq(issueSyncLink.externalNumber, number)),
    );
  return link ?? null;
}

// Writes the provider's issue state. An unknown open issue is imported; an unknown closed
// one is not. Per field, a value the provider did not change since the last sync is kept;
// when both sides changed it, the later change wins.
export async function applyProviderIssue(
  repo: SyncRepository,
  external: ProviderIssue,
): Promise<void> {
  const link = await findLink(repo, external.number);
  if (!link) {
    if (external.state === 'open') await importIssue(repo, external);
    return;
  }
  const externalUpdatedAt = new Date(external.updatedAt);
  if (externalUpdatedAt < link.externalUpdatedAt) return;
  const local = await localSyncFields(link.issueId);
  if (!local) return;
  const incoming = await providerFields(local.projectId, external);
  const incomingHashes = fieldHashes(incoming);
  const incomingHash = stateHash(incomingHashes);
  const base = link.fieldHashes as Partial<FieldHashes>;
  const next = { ...base };
  const apply = new Set<SyncField>();
  if (incomingHash !== link.syncedHash) {
    const localHashes = fieldHashes(local.fields);
    for (const field of SYNC_FIELDS) {
      const value = incomingHashes[field];
      if (value === base[field]) continue;
      if (value !== localHashes[field]) {
        if (localHashes[field] !== base[field]) {
          const changedAt = await localChangedAt(local.id, field);
          if (changedAt && changedAt > externalUpdatedAt) continue;
        }
        apply.add(field);
      }
      next[field] = value;
    }
  }

  const patch: IssuePatch = {};
  if (apply.has('title') && incoming.title) patch.title = incoming.title;
  if (apply.has('description')) patch.description = incoming.description;
  if (apply.has('assignee')) patch.assigneeUserId = incoming.assignee;
  // A status without a target column, or a move a full column refuses, stays unsynced,
  // so a later run tries it again.
  if (apply.has('status')) {
    const columnId = await statusColumnId(local.projectId, incoming.status);
    if (columnId === null) next.status = base.status;
    else patch.columnId = columnId;
  }
  if (Object.keys(patch).length > 0) {
    const updated = await updateIssue(local.id, patch, ACTOR, { skipIfColumnFull: true });
    if (patch.columnId !== undefined && updated?.columnId !== patch.columnId) {
      next.status = base.status;
    }
  }
  if (apply.has('labels')) {
    await setIssueLabels(
      local.projectId,
      local.id,
      await labelIds(local.projectId, external.labels),
      ACTOR,
    );
  }

  await db
    .update(issueSyncLink)
    .set({ syncedHash: incomingHash, fieldHashes: next, externalUpdatedAt })
    .where(eq(issueSyncLink.id, link.id));
  await upsertIssueLink(repo, local.id, external);
}

// A provider issue that was deleted or moved to another repository: the issue is
// canceled and its link removed.
export async function unlinkProviderIssue(repo: SyncRepository, number: number): Promise<void> {
  const link = await findLink(repo, number);
  if (!link) return;
  const local = await localSyncFields(link.issueId);
  if (local && local.stateType !== 'canceled') {
    const columnId = await statusColumnId(local.projectId, 'not_planned');
    if (columnId !== null)
      await updateIssue(local.id, { columnId }, ACTOR, { skipIfColumnFull: true });
  }
  await db.delete(issueSyncLink).where(eq(issueSyncLink.id, link.id));
  await db
    .delete(issueDevelopmentLink)
    .where(
      and(
        eq(issueDevelopmentLink.issueId, link.issueId),
        eq(issueDevelopmentLink.provider, 'github'),
        eq(issueDevelopmentLink.repository, repo.fullName),
        eq(issueDevelopmentLink.externalKey, `issue:${number}`),
      ),
    );
}

async function readBotUserId(repo: SyncRepository): Promise<string | null> {
  const [row] = await db
    .select({ botUserId: gitProviderConnection.botUserId })
    .from(gitProviderConnection)
    .where(eq(gitProviderConnection.id, repo.connectionId));
  return row?.botUserId ?? null;
}

// The connection's bot user, the author of a comment whose provider author has no
// linked account. Created on first use.
async function botUserId(repo: SyncRepository): Promise<string> {
  const existing = await readBotUserId(repo);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db
    .insert(user)
    .values({ id, name: 'GitHub', email: `${id}@issue-sync.local`, emailVerified: false });
  const claimed = await db
    .update(gitProviderConnection)
    .set({ botUserId: id })
    .where(
      and(eq(gitProviderConnection.id, repo.connectionId), isNull(gitProviderConnection.botUserId)),
    )
    .returning({ id: gitProviderConnection.id });
  if (claimed.length > 0) return id;
  await db.delete(user).where(eq(user.id, id));
  const winner = await readBotUserId(repo);
  if (!winner) throw new Error('Issue sync bot user was not stored');
  return winner;
}

export async function applyProviderComment(
  repo: SyncRepository,
  comment: ProviderIssueComment,
  action: 'created' | 'edited' | 'deleted',
): Promise<void> {
  const link = await findLink(repo, comment.issueNumber);
  if (!link) return;
  const [synced] = await db
    .select({
      id: issueCommentSyncLink.id,
      activityId: issueCommentSyncLink.activityId,
      syncedHash: issueCommentSyncLink.syncedHash,
      externalAuthorLogin: issueCommentSyncLink.externalAuthorLogin,
      externalUpdatedAt: issueCommentSyncLink.externalUpdatedAt,
      body: issueActivity.body,
      authorId: issueActivity.actorUserId,
      editedAt: issueActivity.editedAt,
      projectId: issue.projectId,
    })
    .from(issueCommentSyncLink)
    .innerJoin(issueActivity, eq(issueActivity.id, issueCommentSyncLink.activityId))
    .innerJoin(issue, eq(issue.id, issueActivity.issueId))
    .where(
      and(
        eq(issueCommentSyncLink.issueSyncLinkId, link.id),
        eq(issueCommentSyncLink.externalId, comment.externalId),
      ),
    );

  if (action === 'deleted') {
    if (synced) await deleteComment(synced.activityId, synced.authorId, synced.projectId);
    return;
  }

  const hash = commentHash(comment.body);
  const externalUpdatedAt = new Date(comment.updatedAt);
  if (synced) {
    if (hash === synced.syncedHash || externalUpdatedAt < synced.externalUpdatedAt) return;
    const localChanged = commentHash(synced.body ?? '') !== synced.syncedHash;
    if (localChanged && synced.editedAt && synced.editedAt > externalUpdatedAt) return;
    const fromBot = synced.authorId !== null && synced.authorId === (await readBotUserId(repo));
    // A comment It's a Plan posted carries a header there, which is not part of its text.
    const body =
      synced.externalAuthorLogin === null ? stripCommentHeader(comment.body) : comment.body;
    await updateComment(synced.activityId, body, synced.authorId, synced.projectId, {
      mentions: !fromBot,
    });
    await db
      .update(issueCommentSyncLink)
      .set({ syncedHash: hash, externalUpdatedAt })
      .where(eq(issueCommentSyncLink.id, synced.id));
    return;
  }

  const [owner] = await db
    .select({ projectId: issue.projectId })
    .from(issue)
    .where(eq(issue.id, link.issueId));
  if (!owner) return;
  const author = comment.author;
  const memberId = author
    ? (await linkedMembers(owner.projectId, [author.id])).get(author.id)
    : undefined;
  const created = await createComment(
    memberId
      ? { issueId: link.issueId, actorUserId: memberId, body: comment.body }
      : {
          issueId: link.issueId,
          actorUserId: await botUserId(repo),
          authorName: author?.login ?? 'GitHub',
          body: comment.body,
        },
  );
  await db.insert(issueCommentSyncLink).values({
    activityId: created.id,
    issueSyncLinkId: link.id,
    externalId: comment.externalId,
    externalUrl: comment.url ?? link.externalUrl,
    externalAuthorLogin: author?.login ?? null,
    syncedHash: hash,
    externalUpdatedAt,
  });
}
