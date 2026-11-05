import { db, gitManagedRepository, gitProviderConnection, issueSyncInbox } from '@repo/db';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { claimGitDelivery } from '#modules/git/service';
import type { IssueCommentEvent, IssueEvent } from '#modules/git/providers';
import {
  applyProviderComment,
  applyProviderIssue,
  unlinkProviderIssue,
  type SyncRepository,
} from './inbound';
import { MAX_ATTEMPTS, errorMessage, retryAt, track } from './queue';
import { loadSyncRepository, withRepositoryLock } from './service';

// Applies the provider's issue and comment webhooks. The webhook only stores a delivery
// in issue_sync_inbox, because the provider gives up on an answer after a few seconds
// and does not send a failed delivery again, while applying it may wait for a busy
// repository. The reconcile cannot see a deleted issue or comment, so such a delivery
// must not be lost.

type InboxEvent = IssueEvent | IssueCommentEvent;
type InboxRow = typeof issueSyncInbox.$inferSelect;

// Repositories with a run started by a delivery that has not read the inbox yet. A
// delivery for one of them needs no run of its own.
const pending = new Set<number>();

// Stores a verified delivery for the project's repository and starts applying it.
// Nothing is stored when the repository does not sync its issues.
export async function queueIssueSyncEvent(
  projectId: number,
  deliveryId: string | null,
  event: InboxEvent,
): Promise<'issue' | 'duplicate'> {
  const [repository] = await db
    .select({ id: gitManagedRepository.id })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        eq(gitManagedRepository.projectId, projectId),
        eq(gitManagedRepository.issuesSyncEnabled, true),
        eq(gitProviderConnection.provider, 'github'),
        sql`lower(${gitManagedRepository.fullName}) = lower(${event.repo})`,
      ),
    )
    .limit(1);
  if (!repository) return 'issue';

  // The claim keeps a delivery applied before from being stored again; the unique
  // delivery id keeps one that is still stored from being stored twice.
  const stored = await db.transaction(async (tx) => {
    if (deliveryId && !(await claimGitDelivery(projectId, deliveryId, tx))) return false;
    const rows = await tx
      .insert(issueSyncInbox)
      .values({
        managedRepositoryId: repository.id,
        deliveryId,
        externalNumber: event.kind === 'issue' ? event.issue.number : event.comment.issueNumber,
        event,
      })
      .onConflictDoNothing()
      .returning({ id: issueSyncInbox.id });
    return rows.length > 0;
  });
  if (!stored) return 'duplicate';

  if (!pending.has(repository.id)) {
    pending.add(repository.id);
    // A repository that stays busy past the deadline answers 503; the background run
    // applies its deliveries later.
    const run = processRepository(repository.id, true)
      .catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 503) return;
        console.error(`[issue-sync] inbox of repository ${repository.id} failed:`, error);
      })
      .finally(() => pending.delete(repository.id));
    track(run);
  }
  return 'issue';
}

// Run by the background job: applies the deliveries that are due, among them the ones
// whose run met a busy repository. A repository another replica is syncing is skipped.
export async function processIssueSyncInbox(): Promise<void> {
  const rows = await db
    .selectDistinct({ id: issueSyncInbox.managedRepositoryId })
    .from(issueSyncInbox)
    .where(lte(issueSyncInbox.nextAttemptAt, sql`now()`));
  for (const { id } of rows) {
    try {
      await processRepository(id, false);
    } catch (error) {
      console.error(`[issue-sync] inbox of repository ${id} failed:`, error);
    }
  }
}

// Applies the repository's deliveries in the order they arrived. A delivery that waits
// for its retry holds back the later ones for the same external issue, so a comment is
// never applied before the issue it belongs to.
async function processRepository(repositoryId: number, wait: boolean): Promise<void> {
  await withRepositoryLock(repositoryId, wait, async () => {
    pending.delete(repositoryId);
    const repo = await loadSyncRepository(repositoryId);
    if (!repo) {
      await db.delete(issueSyncInbox).where(eq(issueSyncInbox.managedRepositoryId, repositoryId));
      return;
    }
    const rows = await db
      .select()
      .from(issueSyncInbox)
      .where(
        and(
          eq(issueSyncInbox.managedRepositoryId, repositoryId),
          isNotNull(issueSyncInbox.nextAttemptAt),
        ),
      )
      .orderBy(asc(issueSyncInbox.id));
    const held = new Set<number>();
    const now = new Date();
    for (const row of rows) {
      if (held.has(row.externalNumber)) continue;
      if (row.nextAttemptAt! > now || !(await applyRow(repo, row))) held.add(row.externalNumber);
    }
  });
}

// False when the delivery failed and waits for its retry. One the sync gave up on stays
// with its error and holds back nothing.
async function applyRow(repo: SyncRepository, row: InboxRow): Promise<boolean> {
  try {
    await applyEvent(repo, row.event as InboxEvent);
    await db.delete(issueSyncInbox).where(eq(issueSyncInbox.id, row.id));
    return true;
  } catch (error) {
    const attempts = row.attempts + 1;
    const gaveUp = attempts >= MAX_ATTEMPTS;
    if (gaveUp) console.error(`[issue-sync] gave up on inbox row ${row.id}:`, error);
    await db
      .update(issueSyncInbox)
      .set({
        attempts,
        lastError: errorMessage(error),
        nextAttemptAt: gaveUp ? null : retryAt(attempts),
      })
      .where(eq(issueSyncInbox.id, row.id));
    return gaveUp;
  }
}

async function applyEvent(repo: SyncRepository, event: InboxEvent): Promise<void> {
  if (event.kind === 'issue_comment') {
    await applyProviderComment(repo, event.comment, event.action);
  } else if (event.action === 'deleted' || event.action === 'transferred') {
    await unlinkProviderIssue(repo, event.issue.number);
  } else {
    await applyProviderIssue(repo, event.issue);
  }
}
