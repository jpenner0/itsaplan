import {
  db,
  gitManagedRepository,
  gitProviderConnection,
  issue,
  issueDevelopmentLink,
  issueSyncLink,
  project,
} from '@repo/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { queueEventRuns } from '#modules/agents/schedules/issue-runs';
import { parseGithubIssueNumbers, type IssueRef } from './magic-words';
import type { GitProviderKey, PullRequestEvent } from './providers';

// Pull requests and the issues synced with a GitHub repository: GitHub's own `#42`
// references resolve to those issues, and a pull request that is opened or marked
// ready starts the project's review schedules on one of them.

const githubRepositories = (projectIds: number[], fullName: string) =>
  db
    .select({
      id: gitManagedRepository.id,
      projectId: gitManagedRepository.projectId,
      fullName: gitManagedRepository.fullName,
      webUrl: gitManagedRepository.webUrl,
      status: gitManagedRepository.status,
    })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitProviderConnection.id, gitManagedRepository.connectionId),
    )
    .where(
      and(
        inArray(gitManagedRepository.projectId, projectIds),
        eq(gitManagedRepository.fullName, fullName),
        eq(gitProviderConnection.provider, 'github'),
      ),
    );

// The issues of this project synced with the pull request's repository that the pull
// request names as `#42`, `owner/repo#42` or by URL, in the order they appear. Only the
// project's own repositories count: the delivery is signed with this project's secret.
export async function resolveGithubIssueRefs(
  target: { id: number; key: string },
  event: PullRequestEvent,
): Promise<IssueRef[]> {
  const refs: IssueRef[] = [];
  for (const repository of await githubRepositories([target.id], event.repo)) {
    const numbers = parseGithubIssueNumbers(
      `${event.title}\n${event.body}\n${event.sourceBranch ?? ''}`,
      repository.fullName,
      repository.webUrl,
    );
    if (numbers.length === 0) continue;
    const rows = await db
      .select({ number: issueSyncLink.externalNumber, sequenceNumber: issue.sequenceNumber })
      .from(issueSyncLink)
      .innerJoin(issue, eq(issue.id, issueSyncLink.issueId))
      .where(
        and(
          eq(issueSyncLink.managedRepositoryId, repository.id),
          inArray(issueSyncLink.externalNumber, numbers),
          eq(issue.projectId, target.id),
          isNull(issue.archivedAt),
        ),
      );
    const byNumber = new Map(rows.map((row) => [row.number, row.sequenceNumber]));
    for (const number of numbers) {
      const sequenceNumber = byNumber.get(number);
      if (sequenceNumber != null) refs.push({ key: target.key.toUpperCase(), sequenceNumber });
    }
  }
  return refs;
}

// Only a new pull request ready for review is reviewed, not each push, because a review
// costs a model run. A later review is asked for by mentioning the agent on the issue.
function startsReview(providerKey: GitProviderKey, event: PullRequestEvent): boolean {
  return (
    providerKey === 'github' &&
    !event.draft &&
    (event.providerAction === 'opened' || event.providerAction === 'ready_for_review')
  );
}

// Queues the pull_request_opened schedules of each project once, on the first of the
// linked issues in that project that is synced. The prompt holds no text from the
// pull request: the repository name and the URL come from the stored repository.
export async function queuePullRequestReviews(
  providerKey: GitProviderKey,
  event: PullRequestEvent,
  issueIds: number[],
): Promise<void> {
  if (!startsReview(providerKey, event) || issueIds.length === 0) return;
  const rows = await db
    .select({
      issueId: issue.id,
      projectId: issue.projectId,
      identifier: sql<string>`${project.key} || '-' || ${issue.sequenceNumber}`,
      synced: issueSyncLink.id,
      linkId: issueDevelopmentLink.id,
    })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .leftJoin(issueSyncLink, eq(issueSyncLink.issueId, issue.id))
    .leftJoin(
      issueDevelopmentLink,
      and(
        eq(issueDevelopmentLink.issueId, issue.id),
        eq(issueDevelopmentLink.provider, 'github'),
        eq(issueDevelopmentLink.repository, event.repo),
        eq(issueDevelopmentLink.externalKey, `pull_request:${event.number}`),
      ),
    )
    .where(inArray(issue.id, issueIds));
  const byId = new Map(rows.map((row) => [row.issueId, row]));
  const ordered = issueIds.flatMap((id) => byId.get(id) ?? []);
  const repositories = new Map(
    (await githubRepositories([...new Set(ordered.map((row) => row.projectId))], event.repo))
      // The pull request tools reach only a connected repository.
      .filter((repository) => repository.status === 'connected')
      .map((repository) => [repository.projectId, repository]),
  );

  const reviewed = new Set<number>();
  for (const row of ordered) {
    const repository = repositories.get(row.projectId);
    if (row.synced == null || row.linkId == null || !repository || reviewed.has(row.projectId))
      continue;
    reviewed.add(row.projectId);
    const others = ordered.filter((other) => other !== row).map((other) => other.identifier);
    const url = `${repository.webUrl.replace(/\/$/, '')}/pull/${event.number}`;
    const alsoNamed = others.length > 0 ? `, and also ${others.join(', ')}` : '';
    await queueEventRuns({
      type: 'pull_request_opened',
      projectId: row.projectId,
      issueId: row.issueId,
      lead:
        `Pull request ${repository.fullName}#${event.number} (${url}) references work item ` +
        `${row.identifier}${alsoNamed}. ` +
        `Review it: read the diff with get_pull_request_diff (issueId ${row.issueId}, linkId ` +
        `${row.linkId}) and post one review comment with comment_on_pull_request. ` +
        'Do not approve or request changes.',
    });
  }
}
