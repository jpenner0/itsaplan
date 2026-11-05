import {
  db,
  gitManagedRepository,
  gitProviderConnection,
  issueDevelopmentLink,
  project,
  user,
} from '@repo/db';
import { decryptSecret, encryptSecret } from '@repo/crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import { commentHeader } from '#modules/issue-sync/normalize';
import {
  createProviderPullRequest,
  deleteProviderWebhook,
  createPullRequestComment,
  getProviderAccount,
  getProviderPullRequest,
  getProviderPullRequestDiff,
  getProviderRepository,
  installProviderWebhook,
  listProviderBranches,
  listProviderPullRequests,
  listProviderRepositories,
  normalizeProviderBaseUrl,
  type CreateProviderPullRequestInput,
  type GitProvider,
  type ProviderBranchPage,
  type ProviderConnectionInput,
  type ProviderPullRequestDetails,
  type ProviderPullRequestPage,
  type ProviderRepository,
} from './connections-provider';
import { getOrCreateGitSettings, type GitSettings } from './service';

export interface GitProviderConnectionDto {
  id: number;
  provider: GitProvider;
  baseUrl: string;
  accountLogin: string;
  repositories: GitManagedRepositoryDto[];
  createdAt: string;
  updatedAt: string;
}

export interface GitManagedRepositoryDto {
  id: number;
  externalId: string;
  fullName: string;
  webUrl: string;
  status: 'connected' | 'error';
  lastError: string | null;
  issuesSyncEnabled: boolean;
  newIssuesToProvider: boolean;
}

export interface DevelopmentRepositoryDto {
  id: number;
  provider: 'github' | 'gitlab';
  fullName: string;
  webUrl: string;
}

interface ConnectionSecret {
  provider: GitProvider;
  baseUrl: string;
  token: string;
}

const repositoryColumns = {
  id: gitManagedRepository.id,
  externalId: gitManagedRepository.externalId,
  fullName: gitManagedRepository.fullName,
  webUrl: gitManagedRepository.webUrl,
  status: gitManagedRepository.status,
  lastError: gitManagedRepository.lastError,
  issuesSyncEnabled: gitManagedRepository.issuesSyncEnabled,
  newIssuesToProvider: gitManagedRepository.newIssuesToProvider,
};

function mapRepository(
  row: Omit<GitManagedRepositoryDto, 'status'> & { status: string },
): GitManagedRepositoryDto {
  return { ...row, status: row.status === 'error' ? 'error' : 'connected' };
}

interface ManagedDevelopmentRepository {
  input: ProviderConnectionInput & { provider: 'github' | 'gitlab' };
  repository: ProviderRepository;
}

async function managedDevelopmentRepository(
  projectId: number,
  repositoryId: number,
): Promise<ManagedDevelopmentRepository> {
  const [row] = await db
    .select({
      provider: gitProviderConnection.provider,
      baseUrl: gitProviderConnection.baseUrl,
      ciphertext: gitProviderConnection.ciphertext,
      iv: gitProviderConnection.iv,
      authTag: gitProviderConnection.authTag,
      externalId: gitManagedRepository.externalId,
      fullName: gitManagedRepository.fullName,
      webUrl: gitManagedRepository.webUrl,
    })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        eq(gitManagedRepository.id, repositoryId),
        eq(gitManagedRepository.projectId, projectId),
        eq(gitManagedRepository.status, 'connected'),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, 'Managed repository not found');
  if (row.provider !== 'github' && row.provider !== 'gitlab')
    throw new HttpError(400, 'Creating and linking pull requests supports GitHub and GitLab');
  return {
    input: { provider: row.provider, baseUrl: row.baseUrl, token: decryptSecret(row) },
    repository: {
      externalId: row.externalId,
      fullName: row.fullName,
      webUrl: row.webUrl,
      private: false,
    },
  };
}

export async function listDevelopmentRepositories(
  projectId: number,
): Promise<DevelopmentRepositoryDto[]> {
  const rows = await db
    .select({
      id: gitManagedRepository.id,
      provider: gitProviderConnection.provider,
      fullName: gitManagedRepository.fullName,
      webUrl: gitManagedRepository.webUrl,
    })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        eq(gitManagedRepository.projectId, projectId),
        eq(gitManagedRepository.status, 'connected'),
        inArray(gitProviderConnection.provider, ['github', 'gitlab']),
      ),
    )
    .orderBy(asc(gitProviderConnection.provider), asc(gitManagedRepository.fullName));
  return rows.map((row) => ({ ...row, provider: row.provider as 'github' | 'gitlab' }));
}

export async function listManagedPullRequests(
  projectId: number,
  repositoryId: number,
  state: 'open' | 'all',
  page: number,
): Promise<{ provider: 'github' | 'gitlab'; repository: string; page: ProviderPullRequestPage }> {
  const managed = await managedDevelopmentRepository(projectId, repositoryId);
  return {
    provider: managed.input.provider,
    repository: managed.repository.fullName,
    page: await listProviderPullRequests(managed.input, managed.repository, state, page),
  };
}

export async function getManagedPullRequest(
  projectId: number,
  repositoryId: number,
  number: number,
): Promise<{ provider: 'github' | 'gitlab'; details: ProviderPullRequestDetails }> {
  const managed = await managedDevelopmentRepository(projectId, repositoryId);
  return {
    provider: managed.input.provider,
    details: await getProviderPullRequest(managed.input, managed.repository, number),
  };
}

export async function listManagedBranches(
  projectId: number,
  repositoryId: number,
  page: number,
): Promise<ProviderBranchPage> {
  const managed = await managedDevelopmentRepository(projectId, repositoryId);
  return listProviderBranches(managed.input, managed.repository, page);
}

export async function createManagedPullRequest(
  projectId: number,
  repositoryId: number,
  input: CreateProviderPullRequestInput,
): Promise<{ provider: 'github' | 'gitlab'; details: ProviderPullRequestDetails }> {
  const managed = await managedDevelopmentRepository(projectId, repositoryId);
  return {
    provider: managed.input.provider,
    details: await createProviderPullRequest(managed.input, managed.repository, input),
  };
}

async function repositoriesByConnection(
  projectId: number | undefined,
  connectionIds: number[],
): Promise<Map<number, GitManagedRepositoryDto[]>> {
  if (connectionIds.length === 0) return new Map();
  const rows = await db
    .select({ connectionId: gitManagedRepository.connectionId, ...repositoryColumns })
    .from(gitManagedRepository)
    .where(
      projectId === undefined
        ? inArray(gitManagedRepository.connectionId, connectionIds)
        : and(
            eq(gitManagedRepository.projectId, projectId),
            inArray(gitManagedRepository.connectionId, connectionIds),
          ),
    )
    .orderBy(asc(gitManagedRepository.fullName));
  const grouped = new Map<number, GitManagedRepositoryDto[]>();
  for (const row of rows) {
    const repositories = grouped.get(row.connectionId) ?? [];
    repositories.push(mapRepository(row));
    grouped.set(row.connectionId, repositories);
  }
  return grouped;
}

export async function listGitProviderConnections(
  projectId: number,
): Promise<GitProviderConnectionDto[]> {
  const teamId = await projectTeamId(projectId);
  return listTeamGitProviderConnections(teamId, projectId);
}

async function projectTeamId(projectId: number): Promise<number> {
  const [row] = await db
    .select({ teamId: project.teamId })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw new HttpError(404, 'Project not found');
  return row.teamId;
}

export async function listTeamGitProviderConnections(
  teamId: number,
  projectId?: number,
): Promise<GitProviderConnectionDto[]> {
  const rows = await db
    .select({
      id: gitProviderConnection.id,
      provider: gitProviderConnection.provider,
      baseUrl: gitProviderConnection.baseUrl,
      accountLogin: gitProviderConnection.accountLogin,
      createdAt: gitProviderConnection.createdAt,
      updatedAt: gitProviderConnection.updatedAt,
    })
    .from(gitProviderConnection)
    .where(eq(gitProviderConnection.teamId, teamId))
    .orderBy(asc(gitProviderConnection.provider), asc(gitProviderConnection.baseUrl));
  const repositories = await repositoriesByConnection(
    projectId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider as GitProvider,
    baseUrl: row.baseUrl,
    accountLogin: row.accountLogin,
    repositories: repositories.get(row.id) ?? [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}

async function connectionSecret(id: number, projectId: number): Promise<ConnectionSecret> {
  return teamConnectionSecret(id, await projectTeamId(projectId));
}

async function teamConnectionSecret(id: number, teamId: number): Promise<ConnectionSecret> {
  const rows = await db
    .select()
    .from(gitProviderConnection)
    .where(and(eq(gitProviderConnection.id, id), eq(gitProviderConnection.teamId, teamId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Provider connection not found');
  if (!['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket'].includes(row.provider)) {
    throw new HttpError(400, 'Unknown Git provider');
  }
  return {
    provider: row.provider as GitProvider,
    baseUrl: row.baseUrl,
    token: decryptSecret(row),
  };
}

function providerInput(connection: ConnectionSecret): ProviderConnectionInput {
  return {
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    token: connection.token,
  };
}

export async function connectGitProvider(
  teamId: number,
  input: { provider: GitProvider; baseUrl?: string; token: string },
): Promise<GitProviderConnectionDto> {
  const token = input.token.trim();
  if (!token) throw new HttpError(400, 'token is required');
  const baseUrl = await normalizeProviderBaseUrl(input.provider, input.baseUrl);
  const accountLogin = await getProviderAccount({ provider: input.provider, baseUrl, token });
  const encrypted = encryptSecret(token);
  // A team can hold several connections of one account: the migration from
  // project-owned connections keeps each project's token. Saving the account
  // rotates all of them.
  let rows = await db
    .update(gitProviderConnection)
    .set({ ...encrypted, updatedAt: new Date() })
    .where(
      and(
        eq(gitProviderConnection.teamId, teamId),
        eq(gitProviderConnection.provider, input.provider),
        eq(gitProviderConnection.baseUrl, baseUrl),
        eq(gitProviderConnection.accountLogin, accountLogin),
      ),
    )
    .returning({ id: gitProviderConnection.id });
  if (rows.length === 0) {
    rows = await db
      .insert(gitProviderConnection)
      .values({ teamId, provider: input.provider, baseUrl, accountLogin, ...encrypted })
      .returning({ id: gitProviderConnection.id });
  }
  const connectionId = rows[0]?.id;
  if (!connectionId) throw new HttpError(500, 'Provider connection was not stored');
  for (const row of rows) {
    await reconcileConnectionWebhooks(row.id, { provider: input.provider, baseUrl, token });
  }
  const connections = await listTeamGitProviderConnections(teamId);
  const connection = connections.find((item) => item.id === connectionId);
  if (!connection) throw new HttpError(500, 'Provider connection was not stored');
  return connection;
}

async function reconcileConnectionWebhooks(
  connectionId: number,
  input: ProviderConnectionInput,
): Promise<void> {
  const repositories = await db
    .select()
    .from(gitManagedRepository)
    .where(eq(gitManagedRepository.connectionId, connectionId));
  const settingsByProject = new Map<number, GitSettings>();
  for (const repository of repositories) {
    let settings = settingsByProject.get(repository.projectId);
    if (!settings) {
      settings = await getOrCreateGitSettings(repository.projectId);
      settingsByProject.set(repository.projectId, settings);
    }
    await reconcileRepositoryWebhook(input, repository, settings);
  }
}

async function reconcileRepositoryWebhook(
  input: ProviderConnectionInput,
  repository: typeof gitManagedRepository.$inferSelect,
  settings: GitSettings,
): Promise<void> {
  try {
    const webhookExternalId = await installProviderWebhook(
      input,
      {
        externalId: repository.externalId,
        fullName: repository.fullName,
        webUrl: repository.webUrl,
        private: false,
      },
      settings.payloadUrl,
      settings.secret,
      repository.webhookExternalId,
    );
    await db
      .update(gitManagedRepository)
      .set({ webhookExternalId, status: 'connected', lastError: null, updatedAt: new Date() })
      .where(eq(gitManagedRepository.id, repository.id));
  } catch (error) {
    await db
      .update(gitManagedRepository)
      .set({
        status: 'error',
        lastError: error instanceof Error ? error.message : 'Webhook update failed',
        updatedAt: new Date(),
      })
      .where(eq(gitManagedRepository.id, repository.id));
  }
}

export async function listAvailableRepositories(
  projectId: number,
  connectionId: number,
  page: number,
  search: string,
) {
  const connection = await connectionSecret(connectionId, projectId);
  const result = await listProviderRepositories(providerInput(connection), page, search.trim());
  const managed = await db
    .select({ id: gitManagedRepository.id, externalId: gitManagedRepository.externalId })
    .from(gitManagedRepository)
    .where(
      and(
        eq(gitManagedRepository.projectId, projectId),
        eq(gitManagedRepository.connectionId, connectionId),
      ),
    );
  const managedByExternalId = new Map(managed.map((repo) => [repo.externalId, repo.id]));
  return {
    repositories: result.repositories.map((repo) => ({
      ...repo,
      managedRepositoryId: managedByExternalId.get(repo.externalId) ?? null,
    })),
    nextPage: result.nextPage,
  };
}

export async function connectRepositories(
  projectId: number,
  connectionId: number,
  externalIds: string[],
): Promise<GitProviderConnectionDto> {
  const ids = [...new Set(externalIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new HttpError(400, 'Select at least one repository');
  if (ids.length > 50) throw new HttpError(400, 'Select at most 50 repositories');
  const connection = await connectionSecret(connectionId, projectId);
  const existing = await db
    .select({ externalId: gitManagedRepository.externalId })
    .from(gitManagedRepository)
    .where(
      and(
        eq(gitManagedRepository.connectionId, connectionId),
        eq(gitManagedRepository.projectId, projectId),
        inArray(gitManagedRepository.externalId, ids),
      ),
    );
  const existingIds = new Set(existing.map((repo) => repo.externalId));
  const settings = await getOrCreateGitSettings(projectId);
  for (const externalId of ids) {
    if (existingIds.has(externalId)) continue;
    const repository = await getProviderRepository(providerInput(connection), externalId);
    const webhookExternalId = await installProviderWebhook(
      providerInput(connection),
      repository,
      settings.payloadUrl,
      settings.secret,
      null,
    );
    await db.insert(gitManagedRepository).values({
      projectId,
      connectionId,
      externalId: repository.externalId,
      fullName: repository.fullName,
      webUrl: repository.webUrl,
      webhookExternalId,
    });
  }
  return connectionDto(projectId, connectionId);
}

async function connectionDto(projectId: number, connectionId: number) {
  const connections = await listGitProviderConnections(projectId);
  const connection = connections.find((item) => item.id === connectionId);
  if (!connection) throw new HttpError(404, 'Provider connection not found');
  return connection;
}

export async function disconnectRepository(
  projectId: number,
  connectionId: number,
  repositoryId: number,
): Promise<void> {
  const connection = await connectionSecret(connectionId, projectId);
  const rows = await db
    .select()
    .from(gitManagedRepository)
    .where(
      and(
        eq(gitManagedRepository.id, repositoryId),
        eq(gitManagedRepository.connectionId, connectionId),
        eq(gitManagedRepository.projectId, projectId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Managed repository not found');
  await deleteProviderWebhook(
    providerInput(connection),
    { externalId: row.externalId, fullName: row.fullName, webUrl: row.webUrl, private: false },
    row.webhookExternalId,
  );
  await db.delete(gitManagedRepository).where(eq(gitManagedRepository.id, repositoryId));
}

export async function disconnectGitProvider(teamId: number, connectionId: number): Promise<void> {
  const connection = await teamConnectionSecret(connectionId, teamId);
  const repositories = await db
    .select()
    .from(gitManagedRepository)
    .where(eq(gitManagedRepository.connectionId, connectionId));
  for (const repository of repositories) {
    await deleteProviderWebhook(
      providerInput(connection),
      {
        externalId: repository.externalId,
        fullName: repository.fullName,
        webUrl: repository.webUrl,
        private: false,
      },
      repository.webhookExternalId,
    );
  }
  await db
    .delete(gitProviderConnection)
    .where(
      and(eq(gitProviderConnection.id, connectionId), eq(gitProviderConnection.teamId, teamId)),
    );
}

export async function reconcileManagedWebhooks(
  projectId: number,
  settings: GitSettings,
): Promise<void> {
  const connections = await listGitProviderConnections(projectId);
  for (const item of connections) {
    const input = providerInput(await connectionSecret(item.id, projectId));
    const repositories = await db
      .select()
      .from(gitManagedRepository)
      .where(
        and(
          eq(gitManagedRepository.projectId, projectId),
          eq(gitManagedRepository.connectionId, item.id),
        ),
      );
    for (const repository of repositories) {
      await reconcileRepositoryWebhook(input, repository, settings);
    }
  }
}

export async function postPullRequestLinkback(
  projectId: number,
  provider: GitProvider,
  repository: string,
  number: number,
  body: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      provider: gitProviderConnection.provider,
      baseUrl: gitProviderConnection.baseUrl,
      ciphertext: gitProviderConnection.ciphertext,
      iv: gitProviderConnection.iv,
      authTag: gitProviderConnection.authTag,
      externalId: gitManagedRepository.externalId,
      fullName: gitManagedRepository.fullName,
      webUrl: gitManagedRepository.webUrl,
    })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        eq(gitManagedRepository.projectId, projectId),
        eq(gitProviderConnection.provider, provider),
        eq(gitManagedRepository.fullName, repository),
      ),
    )
    .limit(1);
  if (!row) return false;
  await createPullRequestComment(
    {
      provider,
      baseUrl: row.baseUrl,
      token: decryptSecret(row),
    },
    {
      externalId: row.externalId,
      fullName: row.fullName,
      webUrl: row.webUrl,
      private: false,
    },
    number,
    body,
  );
  return true;
}

export interface LinkedPullRequestDiffDto {
  repository: string;
  number: number;
  url: string | null;
  diff: string;
  truncated: boolean;
}

export interface LinkedPullRequestCommentDto {
  repository: string;
  number: number;
  url: string | null;
}

// Bounds the diff an agent reads, so a large pull request neither fills its context
// nor the api's memory.
export const PULL_REQUEST_DIFF_MAX_BYTES = 100_000;

// The pull request of one development link of this issue, in a repository the project
// manages, with the token of that repository's team connection. Any other pull request
// is out of reach, whatever number is asked for.
async function linkedPullRequest(projectId: number, issueId: number, linkId: number) {
  const [link] = await db
    .select({
      provider: issueDevelopmentLink.provider,
      repository: issueDevelopmentLink.repository,
      number: issueDevelopmentLink.number,
      url: issueDevelopmentLink.url,
    })
    .from(issueDevelopmentLink)
    .where(
      and(
        eq(issueDevelopmentLink.id, linkId),
        eq(issueDevelopmentLink.issueId, issueId),
        eq(issueDevelopmentLink.kind, 'pull_request'),
      ),
    )
    .limit(1);
  if (!link || link.number == null) throw new HttpError(404, 'Pull request link not found');
  if (link.provider !== 'github')
    throw new HttpError(400, 'Reading and commenting on pull requests supports GitHub only');
  const [row] = await db
    .select({
      baseUrl: gitProviderConnection.baseUrl,
      ciphertext: gitProviderConnection.ciphertext,
      iv: gitProviderConnection.iv,
      authTag: gitProviderConnection.authTag,
      externalId: gitManagedRepository.externalId,
      fullName: gitManagedRepository.fullName,
      webUrl: gitManagedRepository.webUrl,
    })
    .from(gitManagedRepository)
    .innerJoin(
      gitProviderConnection,
      eq(gitManagedRepository.connectionId, gitProviderConnection.id),
    )
    .where(
      and(
        eq(gitManagedRepository.projectId, projectId),
        eq(gitManagedRepository.fullName, link.repository),
        eq(gitManagedRepository.status, 'connected'),
        eq(gitProviderConnection.provider, 'github'),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, 'Managed repository not found');
  return {
    input: { provider: 'github' as const, baseUrl: row.baseUrl, token: decryptSecret(row) },
    repository: {
      externalId: row.externalId,
      fullName: row.fullName,
      webUrl: row.webUrl,
      private: false,
    },
    pullRequest: { repository: link.repository, number: link.number, url: link.url },
  };
}

export async function getLinkedPullRequestDiff(
  projectId: number,
  issueId: number,
  linkId: number,
): Promise<LinkedPullRequestDiffDto> {
  const linked = await linkedPullRequest(projectId, issueId, linkId);
  const result = await getProviderPullRequestDiff(
    linked.input,
    linked.repository,
    linked.pullRequest.number,
    PULL_REQUEST_DIFF_MAX_BYTES,
  );
  return { ...linked.pullRequest, ...result };
}

// The team's token posts the comment, so its first line names who wrote it.
export async function commentOnLinkedPullRequest(
  projectId: number,
  issueId: number,
  linkId: number,
  authorId: string,
  body: string,
): Promise<LinkedPullRequestCommentDto> {
  const linked = await linkedPullRequest(projectId, issueId, linkId);
  const [author] = await db.select({ name: user.name }).from(user).where(eq(user.id, authorId));
  await createPullRequestComment(
    linked.input,
    linked.repository,
    linked.pullRequest.number,
    `${commentHeader(author?.name ?? 'Unknown', null)}${body}`,
  );
  return linked.pullRequest;
}
