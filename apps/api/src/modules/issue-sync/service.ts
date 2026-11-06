import {
  db,
  gitManagedRepository,
  gitProviderConnection,
  issueSyncInbox,
  issueSyncLink,
} from '@repo/db';
import { decryptSecret } from '@repo/crypto';
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import { HttpError, intEnv, iso, pgErrorCode } from '#shared/lib';
import { installProviderWebhook } from '#modules/git/connections-provider';
import {
  listProviderIssueComments,
  listProviderIssuesSince,
  listProviderOpenIssues,
} from '#modules/git/issues-provider';
import { getOrCreateGitSettings } from '#modules/git/service';
import { runAsIssueSync } from './context';
import { applyProviderComment, applyProviderIssue, type SyncRepository } from './inbound';

export interface IssueSyncSettingsDto {
  repositoryId: number;
  issuesSyncEnabled: boolean;
  newIssuesToProvider: boolean;
  issuesWatermark: string | null;
}

// Namespace of the per-repository advisory lock, so its keys cannot collide with an
// advisory lock taken anywhere else. The second key is the managed repository id.
const SYNC_LOCK_NS = 8251;

async function loadRepository(where: SQL | undefined) {
  const [row] = await db
    .select({
      id: gitManagedRepository.id,
      projectId: gitManagedRepository.projectId,
      connectionId: gitManagedRepository.connectionId,
      externalId: gitManagedRepository.externalId,
      fullName: gitManagedRepository.fullName,
      webUrl: gitManagedRepository.webUrl,
      webhookExternalId: gitManagedRepository.webhookExternalId,
      issuesSyncEnabled: gitManagedRepository.issuesSyncEnabled,
      newIssuesToProvider: gitManagedRepository.newIssuesToProvider,
      issuesWatermark: gitManagedRepository.issuesWatermark,
      provider: gitProviderConnection.provider,
      baseUrl: gitProviderConnection.baseUrl,
      ciphertext: gitProviderConnection.ciphertext,
      iv: gitProviderConnection.iv,
      authTag: gitProviderConnection.authTag,
    })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(where)
    .limit(1);
  return row ?? null;
}

type RepositoryRow = NonNullable<Awaited<ReturnType<typeof loadRepository>>>;

function syncRepository(row: RepositoryRow): SyncRepository {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    fullName: row.fullName,
    webUrl: row.webUrl,
    issuesWatermark: row.issuesWatermark,
    input: { provider: 'github', baseUrl: row.baseUrl, token: decryptSecret(row) },
  };
}

function toDto(row: {
  id: number;
  issuesSyncEnabled: boolean;
  newIssuesToProvider: boolean;
  issuesWatermark: Date | null;
}): IssueSyncSettingsDto {
  return {
    repositoryId: row.id,
    issuesSyncEnabled: row.issuesSyncEnabled,
    newIssuesToProvider: row.newIssuesToProvider,
    issuesWatermark: row.issuesWatermark ? iso(row.issuesWatermark) : null,
  };
}

// At most this many syncs run at once in one replica. A running sync holds a pooled
// connection for its lock and takes more for its writes, so a cap below the pool size
// keeps the pool from filling with lock holders that wait for a connection.
const MAX_RUNNING_SYNCS = 2;
// A caller waiting for a slot or a repository's lock holds no connection. It retries
// the lock after LOCK_RETRY_MS and answers 503 once ISSUE_SYNC_LOCK_WAIT_MS has passed.
const LOCK_RETRY_MS = 200;

let runningSyncs = 0;
const slotQueue: (() => void)[] = [];

function repositoryBusy(): HttpError {
  return new HttpError(503, 'The repository is busy with another issue sync');
}

async function acquireSyncSlot(deadline: number): Promise<void> {
  if (runningSyncs < MAX_RUNNING_SYNCS) {
    runningSyncs += 1;
    return;
  }
  // The slot is handed over by releaseSyncSlot, so the count stays the same. A waiter
  // leaves the queue at its deadline and is never handed a slot.
  await new Promise<void>((resolve, reject) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        slotQueue.splice(slotQueue.indexOf(waiter), 1);
        reject(repositoryBusy());
      },
      Math.max(0, deadline - Date.now()),
    );
    slotQueue.push(waiter);
  });
}

function releaseSyncSlot(): void {
  const next = slotQueue.shift();
  if (next) next();
  else runningSyncs -= 1;
}

// Runs fn while holding the repository's advisory lock. Returns false without running
// fn when another sync, in this replica or another one, holds the lock.
async function tryRepositoryLock(
  repositoryId: number,
  deadline: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  await acquireSyncSlot(deadline);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${SYNC_LOCK_NS}, ${repositoryId}) as locked`,
      );
      if (!row?.locked) return false;
      await runAsIssueSync(fn);
      return true;
    });
  } finally {
    releaseSyncSlot();
  }
}

// One sync of a repository at a time across replicas. Without `wait`, a held lock skips
// fn; with it, the caller retries until its deadline.
export async function withRepositoryLock(
  repositoryId: number,
  wait: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + intEnv('ISSUE_SYNC_LOCK_WAIT_MS', 60_000);
  while (!(await tryRepositoryLock(repositoryId, deadline, fn))) {
    if (!wait) return;
    if (Date.now() >= deadline) throw repositoryBusy();
    await Bun.sleep(LOCK_RETRY_MS);
  }
}

const enabledRepository = (id: number) =>
  and(eq(gitManagedRepository.id, id), eq(gitManagedRepository.issuesSyncEnabled, true));

// A repository with sync on, ready for provider calls. Null when it does not sync.
export async function loadSyncRepository(id: number): Promise<SyncRepository | null> {
  const row = await loadRepository(enabledRepository(id));
  return row ? syncRepository(row) : null;
}

// One item the services refuse, such as an issue for a full column, must not hold back
// the rest of the repository.
async function skipFailed(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[issue-sync] ${what} was not synced:`, error);
  }
}

// Reads the provider's changes since the watermark and applies them. A repository with
// no watermark has not finished its first import: it reads every open issue instead.
// Call inside the repository lock.
async function pullRepository(repositoryId: number): Promise<void> {
  const row = await loadRepository(enabledRepository(repositoryId));
  if (!row) return;
  const repo = syncRepository(row);
  const startedAt = new Date();
  const since = row.issuesWatermark;
  const issues = since
    ? await listProviderIssuesSince(repo.input, repo.fullName, since)
    : await listProviderOpenIssues(repo.input, repo.fullName);
  issues.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const item of issues) {
    await skipFailed(`issue #${item.number}`, () => applyProviderIssue(repo, item));
  }

  const commentsSince =
    since ??
    (issues.length > 0
      ? new Date(Math.min(...issues.map((item) => Date.parse(item.createdAt))))
      : null);
  const comments = commentsSince
    ? await listProviderIssueComments(repo.input, repo.fullName, commentsSince)
    : [];
  for (const comment of comments) {
    await skipFailed(`comment ${comment.externalId}`, () =>
      applyProviderComment(repo, comment, 'created'),
    );
  }

  // Comments are listed after the issues, so a comment time could pass an issue change
  // made in between. A comment changed after the watermark is read again next run.
  const newest = issues.reduce(
    (max, item) => Math.max(max, Date.parse(item.updatedAt)),
    since?.getTime() ?? 0,
  );
  await db
    .update(gitManagedRepository)
    .set({ issuesWatermark: newest ? new Date(newest) : startedAt })
    .where(eq(gitManagedRepository.id, repositoryId));
}

export async function updateIssueSyncSettings(
  projectId: number,
  connectionId: number,
  repositoryId: number,
  patch: { issuesSyncEnabled?: boolean; newIssuesToProvider?: boolean },
): Promise<IssueSyncSettingsDto> {
  const row = await loadRepository(
    and(
      eq(gitManagedRepository.id, repositoryId),
      eq(gitManagedRepository.connectionId, connectionId),
      eq(gitManagedRepository.projectId, projectId),
    ),
  );
  if (!row) throw new HttpError(404, 'Managed repository not found');
  if (row.provider !== 'github') throw new HttpError(400, 'Issue sync supports GitHub only');

  if (patch.newIssuesToProvider !== undefined) {
    await db
      .update(gitManagedRepository)
      .set({ newIssuesToProvider: patch.newIssuesToProvider, updatedAt: new Date() })
      .where(eq(gitManagedRepository.id, repositoryId));
  }
  if (patch.issuesSyncEnabled === true && !row.issuesSyncEnabled) await enableSync(row);
  if (patch.issuesSyncEnabled === false && row.issuesSyncEnabled) await disableSync(repositoryId);

  const updated = await loadRepository(eq(gitManagedRepository.id, repositoryId));
  if (!updated) throw new HttpError(404, 'Managed repository not found');
  return toDto(updated);
}

// Claims the repository for this project, makes its webhook send issue events, and
// imports its open issues. If the import fails, the sync stays on and the reconcile
// job finishes it.
async function enableSync(row: RepositoryRow): Promise<void> {
  const [other] = await db
    .select({ id: gitManagedRepository.id })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        ne(gitManagedRepository.id, row.id),
        eq(gitManagedRepository.externalId, row.externalId),
        eq(gitManagedRepository.issuesSyncEnabled, true),
        eq(gitProviderConnection.provider, row.provider),
        eq(gitProviderConnection.baseUrl, row.baseUrl),
      ),
    )
    .limit(1);
  if (other) throw syncedElsewhere();
  try {
    await db
      .update(gitManagedRepository)
      .set({ issuesSyncEnabled: true, issuesWatermark: null, updatedAt: new Date() })
      .where(eq(gitManagedRepository.id, row.id));
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw syncedElsewhere();
    throw error;
  }

  const repo = syncRepository(row);
  const settings = await getOrCreateGitSettings(row.projectId);
  const webhookExternalId = await installProviderWebhook(
    repo.input,
    { externalId: row.externalId, fullName: row.fullName, webUrl: row.webUrl, private: false },
    settings.payloadUrl,
    settings.secret,
    row.webhookExternalId,
  );
  await db
    .update(gitManagedRepository)
    .set({ webhookExternalId, status: 'connected', lastError: null })
    .where(eq(gitManagedRepository.id, row.id));
  await withRepositoryLock(row.id, true, () => pullRepository(row.id));
}

function syncedElsewhere(): HttpError {
  return new HttpError(409, 'This repository already syncs its issues with another project');
}

// Both sides keep their issues; only the links and the deliveries not yet applied go.
async function disableSync(repositoryId: number): Promise<void> {
  await withRepositoryLock(repositoryId, true, async () => {
    await db
      .update(gitManagedRepository)
      .set({ issuesSyncEnabled: false, issuesWatermark: null, updatedAt: new Date() })
      .where(eq(gitManagedRepository.id, repositoryId));
    await db.delete(issueSyncLink).where(eq(issueSyncLink.managedRepositoryId, repositoryId));
    await db.delete(issueSyncInbox).where(eq(issueSyncInbox.managedRepositoryId, repositoryId));
  });
}

// The background reconcile: every repository with sync on reads what changed since its
// watermark. A repository another replica is syncing is skipped until the next run.
export async function reconcileIssueSync(): Promise<void> {
  const rows = await db
    .select({ id: gitManagedRepository.id })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        eq(gitManagedRepository.issuesSyncEnabled, true),
        eq(gitProviderConnection.provider, 'github'),
      ),
    );
  for (const { id } of rows) {
    try {
      await withRepositoryLock(id, false, () => pullRepository(id));
    } catch (error) {
      console.error(`[issue-sync] repository ${id} failed:`, error);
    }
  }
}
