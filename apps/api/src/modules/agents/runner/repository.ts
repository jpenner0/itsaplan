import {
  agentRun,
  db,
  gitManagedRepository,
  issue,
  issueDevelopmentLink,
  issueSyncLink,
  project,
} from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { createAndLinkPullRequest } from '#modules/git/development';
import { getManagedDefaultBranch } from '#modules/git/connections-service';

// A delegated issue that is synced with a repository is implemented in a clone of it. The
// api sends the runner the repository URL, the base branch and the branch name, and opens
// the pull request itself from the branch the runner reports, so the team's token never
// reaches the runner.

export interface RunRepository {
  url: string;
  baseBranch: string;
  branch: string;
}

interface RunTarget {
  repository: RunRepository;
  projectId: number;
  repositoryId: number;
  issueId: number;
  title: string;
  externalNumber: number;
}

const MAX_SLUG_LENGTH = 40;

// `abc-123-fix-the-login-bug`: the issue key keeps branches of different issues apart, so
// the name is the same on every delegation and the next run continues on that branch.
export function branchName(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug ? `${identifier.toLowerCase()}-${slug}` : identifier.toLowerCase();
}

async function runTarget(runId: number): Promise<RunTarget | null> {
  const [row] = await db
    .select({
      trigger: agentRun.trigger,
      issueId: issue.id,
      title: issue.title,
      identifier: issue.sequenceNumber,
      projectKey: project.key,
      repositoryId: gitManagedRepository.id,
      repositoryProjectId: gitManagedRepository.projectId,
      webUrl: gitManagedRepository.webUrl,
      externalNumber: issueSyncLink.externalNumber,
    })
    .from(agentRun)
    .innerJoin(issue, eq(issue.id, agentRun.issueId))
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(issueSyncLink, eq(issueSyncLink.issueId, issue.id))
    .innerJoin(gitManagedRepository, eq(gitManagedRepository.id, issueSyncLink.managedRepositoryId))
    .where(and(eq(agentRun.id, runId), eq(gitManagedRepository.status, 'connected')))
    .limit(1);
  if (!row || row.trigger !== 'delegation') return null;
  let baseBranch: string | null;
  try {
    baseBranch = await getManagedDefaultBranch(row.repositoryProjectId, row.repositoryId);
  } catch {
    // A provider other than GitHub or GitLab, or one that cannot be reached: the run
    // goes on without a clone.
    return null;
  }
  if (!baseBranch) return null;
  return {
    repository: {
      url: `${row.webUrl.replace(/\/+$/, '')}.git`,
      baseBranch,
      branch: branchName(`${row.projectKey}-${row.identifier}`, row.title),
    },
    projectId: row.repositoryProjectId,
    repositoryId: row.repositoryId,
    issueId: row.issueId,
    title: row.title,
    externalNumber: row.externalNumber,
  };
}

// Set for the delegation of a synced issue only.
export async function runRepository(runId: number): Promise<RunRepository | null> {
  return (await runTarget(runId))?.repository ?? null;
}

// Opens the pull request for the branch a runner pushed and links it to the issue. The
// branch has to be the one the run was given: the runner holds the agent's key, and the
// team's token must not open a pull request from any other branch. A branch with an open
// pull request, from an earlier delegation, gets no second one. The result is an
// error message, or null when the pull request exists afterwards.
export async function openRunPullRequest(runId: number, branch: string): Promise<string | null> {
  const target = await runTarget(runId);
  if (!target || target.repository.branch !== branch) {
    return 'The reported branch is not the branch of this run';
  }
  const [existing] = await db
    .select({ id: issueDevelopmentLink.id })
    .from(issueDevelopmentLink)
    .where(
      and(
        eq(issueDevelopmentLink.issueId, target.issueId),
        eq(issueDevelopmentLink.kind, 'pull_request'),
        eq(issueDevelopmentLink.state, 'open'),
        eq(issueDevelopmentLink.sourceBranch, branch),
      ),
    )
    .limit(1);
  if (existing) return null;
  try {
    await createAndLinkPullRequest(target.projectId, target.issueId, target.repositoryId, {
      sourceBranch: branch,
      targetBranch: target.repository.baseBranch,
      title: target.title,
      description: `Closes #${target.externalNumber}`,
      draft: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not open the pull request: ${message}`;
  }
  return null;
}
