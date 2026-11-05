import {
  account,
  db,
  gitManagedRepository,
  gitProviderConnection,
  issue,
  issueActivity,
  issueCommentSyncLink,
  issueLabel,
  issueSyncLink,
  issueSyncOutbox,
  label,
  project,
  team,
} from '@repo/db';
import { decryptSecret } from '@repo/crypto';
import { and, asc, eq, lte, sql, type SQL } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { issueUrl, teamRef } from '#modules/teams/ref';
import {
  getProviderRepository,
  type ProviderConnectionInput,
} from '#modules/git/connections-provider';
import {
  addProviderIssueAssignees,
  createProviderIssue,
  createProviderIssueComment,
  createProviderLabel,
  deleteProviderIssueComment,
  getProviderIssue,
  getProviderUser,
  listProviderLabels,
  updateProviderIssue,
  updateProviderIssueComment,
  type ProviderIssue,
  type UpdateProviderIssueInput,
} from '#modules/git/issues-provider';
import { isIssueSyncWrite } from './context';
import {
  localChangedAt,
  localSyncFields,
  providerFields,
  unlinkProviderIssue,
  upsertIssueLink,
  type SyncRepository,
} from './inbound';
import {
  SYNC_FIELDS,
  commentHash,
  commentHeader,
  fieldHashes,
  footerLine,
  labelKey,
  stateHash,
  type FieldHashes,
  type SyncField,
  type SyncFields,
} from './normalize';
import { MAX_ATTEMPTS, errorMessage, retryAt, track } from './queue';
import { loadSyncRepository, withRepositoryLock } from './service';

// Sends It's a Plan's changes to the provider. Triggers queue every change in
// issue_sync_outbox (see its schema comment). A write here pushes its issue's rows at
// once, without waiting for the provider; the background reconcile pushes what is left,
// so a failed push is retried there.

type OutboxRow = typeof issueSyncOutbox.$inferSelect;

// Rows per run, so a long provider outage does not make one run push a whole backlog.
const BATCH_SIZE = 200;

// Pushes in one replica run one after another, so they hold at most one of the sync
// slots in service.ts and leave the others to webhooks and the reconcile.
let pushQueue: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): Promise<void> {
  const run = pushQueue.then(work);
  pushQueue = run.catch(() => undefined);
  track(run);
  return run;
}

// Pushes the issue's queued changes in the background. A no-op for the sync's own writes.
// It does not wait for a repository another sync holds: the background run sends those.
export function pushIssueSync(issueId: number): void {
  if (isIssueSyncWrite()) return;
  void enqueue(() => processOutbox(eq(issueSyncOutbox.issueId, issueId), false)).catch(
    (error: unknown) => console.error('[issue-sync] push failed:', error),
  );
}

// Run by the background reconcile. A repository another replica is syncing is skipped.
export async function processIssueSyncOutbox(): Promise<void> {
  await enqueue(() => processOutbox(undefined, false));
}

// Queues a new issue to be created on the provider, when its project syncs issues and
// sends new ones there.
export async function publishNewIssue(issueId: number, projectId: number): Promise<void> {
  if ((await projectSyncRepositoryId(projectId, true)) === null) return;
  await queueIssue(issueId, true);
  pushIssueSync(issueId);
}

async function queueIssue(issueId: number, publish: boolean): Promise<void> {
  await db
    .insert(issueSyncOutbox)
    .values({ kind: 'issue', issueId, publish })
    .onConflictDoUpdate({
      target: issueSyncOutbox.issueId,
      targetWhere: sql`${issueSyncOutbox.kind} = 'issue'`,
      set: {
        publish: sql`${issueSyncOutbox.publish} or ${publish}`,
        version: sql`${issueSyncOutbox.version} + 1`,
        nextAttemptAt: sql`now()`,
      },
    });
}

export interface PublishedIssueDto {
  issueId: number;
  externalNumber: number;
  externalUrl: string;
}

// "Publish to GitHub": creates the external issue for an existing issue now. A provider
// error fails the request, and nothing is queued.
export async function publishIssue(issueId: number, projectId: number): Promise<PublishedIssueDto> {
  const alreadyLinked = () => new HttpError(409, 'This issue is already synced');
  const notSyncing = () => new HttpError(409, 'This project does not sync its issues');
  if (await findLink(issueId)) throw alreadyLinked();
  const repositoryId = await projectSyncRepositoryId(projectId, false);
  if (repositoryId === null) throw notSyncing();
  await withRepositoryLock(repositoryId, true, async () => {
    const repo = await loadSyncRepository(repositoryId);
    if (!repo) throw notSyncing();
    if (await findLink(issueId)) throw alreadyLinked();
    await createExternalIssue(repo, issueId);
  });
  const link = await findLink(issueId);
  if (!link) throw new HttpError(404, 'Issue not found');
  return { issueId, externalNumber: link.externalNumber, externalUrl: link.externalUrl };
}

async function projectSyncRepositoryId(
  projectId: number,
  newIssues: boolean,
): Promise<number | null> {
  const [row] = await db
    .select({ id: gitManagedRepository.id })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitProviderConnection.id, gitManagedRepository.connectionId),
    )
    .where(
      and(
        eq(gitManagedRepository.projectId, projectId),
        eq(gitManagedRepository.issuesSyncEnabled, true),
        eq(gitProviderConnection.provider, 'github'),
        newIssues ? eq(gitManagedRepository.newIssuesToProvider, true) : undefined,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function findLink(issueId: number) {
  const [link] = await db.select().from(issueSyncLink).where(eq(issueSyncLink.issueId, issueId));
  return link ?? null;
}

type Link = NonNullable<Awaited<ReturnType<typeof findLink>>>;

async function processOutbox(where: SQL | undefined, wait: boolean): Promise<void> {
  const rows = await db
    .select()
    .from(issueSyncOutbox)
    .where(and(lte(issueSyncOutbox.nextAttemptAt, sql`now()`), where))
    .orderBy(asc(issueSyncOutbox.id))
    .limit(BATCH_SIZE);
  for (const row of rows) await processRow(row, wait);
}

// A row is removed only while it is the version that was pushed; a change queued during
// the push keeps it for the next run.
async function processRow(row: OutboxRow, wait: boolean): Promise<void> {
  const current = and(eq(issueSyncOutbox.id, row.id), eq(issueSyncOutbox.version, row.version));
  try {
    if (await pushRow(row, wait)) await db.delete(issueSyncOutbox).where(current);
  } catch (error) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      console.error(`[issue-sync] gave up on outbox row ${row.id} (${row.kind}):`, error);
      await db.delete(issueSyncOutbox).where(current);
      return;
    }
    await db
      .update(issueSyncOutbox)
      .set({ attempts, lastError: errorMessage(error), nextAttemptAt: retryAt(attempts) })
      .where(eq(issueSyncOutbox.id, row.id));
  }
}

// False when the repository is locked by another sync, so the row waits for the next run.
async function pushRow(row: OutboxRow, wait: boolean): Promise<boolean> {
  switch (row.kind) {
    case 'issue':
      return row.issueId === null || pushIssue(row.issueId, row.publish, wait);
    case 'comment':
      return row.activityId === null || pushComment(row.activityId, wait);
    case 'close_issue':
    case 'delete_comment':
      await pushTombstone(row);
      return true;
  }
}

// False when the repository stayed busy: its lock or every sync slot was taken until
// the deadline. That is not a failed push, so it does not count as an attempt.
async function underLock(
  repositoryId: number,
  wait: boolean,
  fn: (repo: SyncRepository) => Promise<void>,
): Promise<boolean> {
  let ran = false;
  try {
    await withRepositoryLock(repositoryId, wait, async () => {
      ran = true;
      const repo = await loadSyncRepository(repositoryId);
      if (repo) await fn(repo);
    });
  } catch (error) {
    if (!ran && error instanceof HttpError && error.status === 503) return false;
    throw error;
  }
  return ran;
}

async function pushIssue(issueId: number, publish: boolean, wait: boolean): Promise<boolean> {
  const link = await findLink(issueId);
  let repositoryId: number | null = link?.managedRepositoryId ?? null;
  if (repositoryId === null && publish) {
    const [owner] = await db
      .select({ projectId: issue.projectId })
      .from(issue)
      .where(eq(issue.id, issueId));
    if (owner) repositoryId = await projectSyncRepositoryId(owner.projectId, false);
  }
  if (repositoryId === null) return true;
  return underLock(repositoryId, wait, async (repo) => {
    const current = await findLink(issueId);
    if (current) await updateExternalIssue(repo, current);
    else if (publish) await createExternalIssue(repo, issueId);
  });
}

interface Outgoing {
  // The provider's view of the local issue, in the form the hashes are taken of.
  fields: SyncFields;
  body: string;
  // Null when the assignee has no linked account; then the assignee is not sent.
  assigneeLogin: string | null;
}

async function outgoing(
  repo: SyncRepository,
  issueId: number,
  fields: SyncFields,
): Promise<Outgoing> {
  const assigneeLogin = fields.assignee ? await providerLogin(repo, fields.assignee) : null;
  const body = await issueBody(issueId, fields.description);
  return {
    fields: { ...fields, description: body, assignee: assigneeLogin ? fields.assignee : null },
    body,
    assigneeLogin,
  };
}

async function providerLogin(repo: SyncRepository, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'github')));
  if (!row) return null;
  return (await getProviderUser(repo.input, row.accountId))?.login ?? null;
}

// An image uploaded to It's a Plan, as markdown: ![name](/media/attachments/<id>/raw).
const LOCAL_IMAGE =
  /!\[([^\]\n]*)\]\(\s*((?:https?:\/\/[^\s)]+)?\/(?:media\/)?attachments\/[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g;

// The provider cannot load an image stored in It's a Plan, so it gets a link to it.
function linkLocalImages(markdown: string): string {
  const base = process.env.APP_URL;
  return markdown.replace(LOCAL_IMAGE, (match, alt: string, url: string) => {
    let path = url;
    if (/^https?:\/\//.test(url)) {
      if (!base || !url.startsWith(`${base}/`)) return match;
      path = url.slice(base.length);
    }
    if (!path.startsWith('/media/')) path = `/media${path}`;
    const name = alt.trim() || 'image';
    return base ? `[📎 ${name} (view in It's a Plan)](${base}${path})` : `📎 ${name}`;
  });
}

async function issueBody(issueId: number, description: string): Promise<string> {
  const [row] = await db
    .select({ key: project.key, seq: issue.sequenceNumber, teamId: team.id, slug: team.slug })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(team, eq(team.id, project.teamId))
    .where(eq(issue.id, issueId));
  const text = linkLocalImages(description).trimEnd();
  if (!row || row.seq === null) return text;
  const url = issueUrl(teamRef({ id: row.teamId, slug: row.slug }), row.key, row.seq);
  if (!url) return text;
  const footer = footerLine(`${row.key}-${row.seq}`, url);
  return text ? `${text}\n\n${footer}` : footer;
}

// The issue's label names. A label the provider does not have is created there with
// its colour.
async function ensureLabels(repo: SyncRepository, issueId: number): Promise<string[]> {
  const rows = await db
    .select({ name: label.name, color: label.color })
    .from(issueLabel)
    .innerJoin(label, eq(label.id, issueLabel.labelId))
    .where(eq(issueLabel.issueId, issueId));
  if (rows.length === 0) return [];
  const existing = await listProviderLabels(repo.input, repo.fullName);
  const known = new Set(existing.map((item) => labelKey(item.name)));
  for (const row of rows) {
    if (known.has(labelKey(row.name))) continue;
    const color = /^#?[0-9a-f]{6}$/i.test(row.color) ? row.color.replace('#', '') : 'ededed';
    await createProviderLabel(repo.input, repo.fullName, row.name.trim(), color);
    known.add(labelKey(row.name));
  }
  return [...new Set(rows.map((row) => row.name.trim()))];
}

function statusInput(fields: SyncFields): UpdateProviderIssueInput {
  return fields.status === 'open'
    ? { state: 'open' }
    : { state: 'closed', stateReason: fields.status };
}

async function createExternalIssue(repo: SyncRepository, issueId: number): Promise<void> {
  const local = await localSyncFields(issueId);
  if (!local) return;
  const out = await outgoing(repo, issueId, local.fields);
  const external = await createProviderIssue(repo.input, repo.fullName, {
    title: out.fields.title,
    body: out.body,
    labels: await ensureLabels(repo, issueId),
    assignees: out.assigneeLogin ? [out.assigneeLogin] : [],
  });
  // The link is stored before anything else can fail, so a retry updates this issue
  // instead of creating a second one. A closed status is sent as an update.
  const hashes = fieldHashes(await providerFields(local.projectId, external));
  const [link] = await db
    .insert(issueSyncLink)
    .values({
      issueId,
      managedRepositoryId: repo.id,
      externalId: external.externalId,
      externalNumber: external.number,
      externalUrl: external.url ?? `${repo.webUrl}/issues/${external.number}`,
      syncedHash: stateHash(hashes),
      fieldHashes: hashes,
      externalUpdatedAt: new Date(external.updatedAt),
    })
    .returning();
  await upsertIssueLink(repo, issueId, external);
  if (out.fields.status === 'open') return;
  try {
    await updateExternalIssue(repo, link!);
  } catch (error) {
    console.error(`[issue-sync] issue ${issueId} was created but not closed:`, error);
    await queueIssue(issueId, false);
  }
}

// Sends the fields that changed locally since the last sync. A field the provider also
// changed, later than the local change, is left for the inbound sync. The stored hashes
// take the provider's values of the fields sent, so their webhook echo is ignored.
async function updateExternalIssue(repo: SyncRepository, link: Link): Promise<void> {
  const local = await localSyncFields(link.issueId);
  if (!local) return;
  const out = await outgoing(repo, link.issueId, local.fields);
  const outHashes = fieldHashes(out.fields);
  const base = link.fieldHashes as FieldHashes;
  const changed = SYNC_FIELDS.filter(
    (field) => outHashes[field] !== base[field] && (field !== 'assignee' || out.assigneeLogin),
  );
  if (changed.length === 0) return;

  const fetched = await getProviderIssue(repo.input, repo.fullName, link.externalNumber);
  if (fetched.status === 'gone') return unlinkProviderIssue(repo, link.externalNumber);
  if (fetched.status === 'moved') return issueMoved(repo, link);
  let external: ProviderIssue = fetched.issue;
  const externalHashes = fieldHashes(await providerFields(local.projectId, external));
  const externalAt = new Date(external.updatedAt);
  const settled: SyncField[] = [];
  const send: SyncField[] = [];
  for (const field of changed) {
    if (externalHashes[field] === outHashes[field]) {
      settled.push(field);
      continue;
    }
    if (externalHashes[field] !== base[field]) {
      const changedAt = await localChangedAt(local.id, field);
      if (!changedAt || changedAt < externalAt) continue;
    }
    send.push(field);
  }

  const patch: UpdateProviderIssueInput = {};
  if (send.includes('title')) patch.title = out.fields.title;
  if (send.includes('description')) patch.body = out.body;
  if (send.includes('status')) Object.assign(patch, statusInput(out.fields));
  if (send.includes('labels')) patch.labels = await ensureLabels(repo, link.issueId);
  if (Object.keys(patch).length > 0) {
    const updated = await updateProviderIssue(
      repo.input,
      repo.fullName,
      link.externalNumber,
      patch,
    );
    if (updated.status === 'gone') return unlinkProviderIssue(repo, link.externalNumber);
    if (updated.status === 'moved') return issueMoved(repo, link);
    external = updated.issue;
  }
  if (send.includes('assignee') && out.assigneeLogin) {
    external = await addProviderIssueAssignees(repo.input, repo.fullName, link.externalNumber, [
      out.assigneeLogin,
    ]);
  }

  const finalHashes = fieldHashes(await providerFields(local.projectId, external));
  const next = { ...base };
  for (const field of [...settled, ...send]) next[field] = finalHashes[field];
  await db
    .update(issueSyncLink)
    .set({ fieldHashes: next, syncedHash: stateHash(next) })
    .where(eq(issueSyncLink.id, link.id));
  await upsertIssueLink(repo, link.issueId, external);
}

// The provider redirects for a transferred issue and for a renamed repository alike. A
// renamed repository is stored under its new name and the push is retried; an issue
// whose repository kept its name was transferred and is unlinked.
async function issueMoved(repo: SyncRepository, link: Link): Promise<void> {
  const [row] = await db
    .select({ externalId: gitManagedRepository.externalId })
    .from(gitManagedRepository)
    .where(eq(gitManagedRepository.id, repo.id));
  if (!row) return;
  const current = await getProviderRepository(repo.input, row.externalId);
  if (current.fullName.toLowerCase() === repo.fullName.toLowerCase()) {
    return unlinkProviderIssue(repo, link.externalNumber);
  }
  await db
    .update(gitManagedRepository)
    .set({ fullName: current.fullName, webUrl: current.webUrl, updatedAt: new Date() })
    .where(eq(gitManagedRepository.id, repo.id));
  throw new Error(`Repository ${repo.fullName} was renamed to ${current.fullName}`);
}

async function pushComment(activityId: number, wait: boolean): Promise<boolean> {
  const [comment] = await db
    .select({
      issueId: issueActivity.issueId,
      body: issueActivity.body,
      actorUserId: issueActivity.actorUserId,
      actorName: issueActivity.actorName,
    })
    .from(issueActivity)
    .where(and(eq(issueActivity.id, activityId), eq(issueActivity.kind, 'comment')));
  if (!comment?.issueId) return true;
  const link = await findLink(comment.issueId);
  if (!link) return true;
  return underLock(link.managedRepositoryId, wait, async (repo) => {
    const [synced] = await db
      .select()
      .from(issueCommentSyncLink)
      .where(eq(issueCommentSyncLink.activityId, activityId));
    const text = linkLocalImages(comment.body ?? '');
    // A comment that came from the provider goes back without the It's a Plan header.
    const body =
      synced && synced.externalAuthorLogin !== null
        ? text
        : commentHeader(
            comment.actorName ?? 'Unknown',
            comment.actorUserId ? await providerLogin(repo, comment.actorUserId) : null,
          ) + text;
    if (synced) {
      if (commentHash(body) === synced.syncedHash) return;
      const updated = await updateProviderIssueComment(
        repo.input,
        repo.fullName,
        synced.externalId,
        body,
      );
      await db
        .update(issueCommentSyncLink)
        .set({ syncedHash: commentHash(updated.body) })
        .where(eq(issueCommentSyncLink.id, synced.id));
      return;
    }
    const created = await createProviderIssueComment(
      repo.input,
      repo.fullName,
      link.externalNumber,
      body,
    );
    await db.insert(issueCommentSyncLink).values({
      activityId,
      issueSyncLinkId: link.id,
      externalId: created.externalId,
      externalUrl: created.url ?? link.externalUrl,
      externalAuthorLogin: null,
      syncedHash: commentHash(created.body),
      externalUpdatedAt: new Date(created.updatedAt),
    });
  });
}

// The repository may have been renamed since the outbox row was written. Reading it by
// id needs admin rights on it; without them, or for a deleted repository, the stored
// name is used.
async function currentRepositoryName(
  input: ProviderConnectionInput,
  storedName: string,
  externalId: string | null,
): Promise<string> {
  if (!externalId) return storedName;
  try {
    return (await getProviderRepository(input, externalId)).fullName;
  } catch {
    return storedName;
  }
}

// A deleted issue is closed as not planned; a deleted comment is deleted. The connection
// may be gone with its team, and then there is nothing to send with.
async function pushTombstone(row: OutboxRow): Promise<void> {
  if (row.connectionId === null || !row.repository || !row.externalId) return;
  const [connection] = await db
    .select()
    .from(gitProviderConnection)
    .where(eq(gitProviderConnection.id, row.connectionId));
  if (!connection || connection.provider !== 'github') return;
  const input: ProviderConnectionInput = {
    provider: 'github',
    baseUrl: connection.baseUrl,
    token: decryptSecret(connection),
  };
  // A close that is still redirected under the current name means the issue was
  // transferred, and it is no longer this repository's to close.
  const repository = await currentRepositoryName(input, row.repository, row.repositoryExternalId);
  if (row.kind === 'delete_comment') {
    await deleteProviderIssueComment(input, repository, row.externalId);
  } else {
    await updateProviderIssue(input, repository, Number(row.externalId), {
      state: 'closed',
      stateReason: 'not_planned',
    });
  }
}
