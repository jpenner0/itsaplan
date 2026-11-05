import { afterAll, beforeAll, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  gitManagedRepository,
  gitProviderConnection,
  issue,
  issueActivity,
  issueCommentSyncLink,
  issueSyncLink,
  project,
  projectColumn,
  team,
  workspace,
} from '../schema';

// Rows are scoped to one workspace that afterAll deletes, so the suite leaves the
// shared test database as it found it.
let workspaceId: number;
let connectionId: number;
let projectIds: [number, number];

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const [ws] = await db.insert(workspace).values({ name: 'sync' }).returning();
  workspaceId = ws.id;
  const [t] = await db.insert(team).values({ name: 'sync', workspaceId }).returning();
  const projects = await db
    .insert(project)
    .values([
      { teamId: t.id, name: 'A', key: `A${suffix}` },
      { teamId: t.id, name: 'B', key: `B${suffix}` },
    ])
    .returning();
  projectIds = [projects[0].id, projects[1].id];
  const [conn] = await db
    .insert(gitProviderConnection)
    .values({
      teamId: t.id,
      provider: 'github',
      baseUrl: 'https://api.github.com',
      accountLogin: 'bot',
      ciphertext: 'x',
      iv: 'x',
      authTag: 'x',
    })
    .returning();
  connectionId = conn.id;
});

afterAll(async () => {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
});

function managedRepository(projectId: number, externalId: string, issuesSyncEnabled: boolean) {
  return {
    projectId,
    connectionId,
    externalId,
    fullName: `acme/${externalId}`,
    webUrl: `https://github.com/acme/${externalId}`,
    webhookExternalId: '1',
    issuesSyncEnabled,
  };
}

it('syncs a repository with at most one project', async () => {
  await db.insert(gitManagedRepository).values(managedRepository(projectIds[0], 'r1', true));
  await db.insert(gitManagedRepository).values(managedRepository(projectIds[1], 'r1', false));

  await expect(
    db
      .update(gitManagedRepository)
      .set({ issuesSyncEnabled: true })
      .where(eq(gitManagedRepository.projectId, projectIds[1]))
      .then(),
  ).rejects.toMatchObject({ cause: { constraint_name: 'git_managed_repository_issues_sync_uq' } });
});

it('deletes the sync links with the repository and keeps the issues', async () => {
  const [repo] = await db
    .insert(gitManagedRepository)
    .values(managedRepository(projectIds[0], 'r2', false))
    .returning();
  const [col] = await db
    .insert(projectColumn)
    .values({ projectId: projectIds[0], name: 'Todo', position: 0 })
    .returning();
  const [iss] = await db
    .insert(issue)
    .values({ projectId: projectIds[0], columnId: col.id, title: 'Bug', sequenceNumber: 1 })
    .returning();
  const [comment] = await db
    .insert(issueActivity)
    .values({ issueId: iss.id, kind: 'comment', body: 'hi' })
    .returning();
  const [link] = await db
    .insert(issueSyncLink)
    .values({
      issueId: iss.id,
      managedRepositoryId: repo.id,
      externalId: 'I_1',
      externalNumber: 1,
      externalUrl: 'https://github.com/acme/r2/issues/1',
      syncedHash: 'h',
      externalUpdatedAt: new Date(),
    })
    .returning();
  await db.insert(issueCommentSyncLink).values({
    activityId: comment.id,
    issueSyncLinkId: link.id,
    externalId: 'IC_1',
    externalUrl: 'https://github.com/acme/r2/issues/1#issuecomment-1',
    externalAuthorLogin: 'octocat',
    syncedHash: 'h',
    externalUpdatedAt: new Date(),
  });

  await db.delete(gitManagedRepository).where(eq(gitManagedRepository.id, repo.id));

  expect(await db.select().from(issueSyncLink).where(eq(issueSyncLink.id, link.id))).toEqual([]);
  expect(
    await db
      .select()
      .from(issueCommentSyncLink)
      .where(eq(issueCommentSyncLink.issueSyncLinkId, link.id)),
  ).toEqual([]);
  expect(await db.select().from(issue).where(eq(issue.id, iss.id))).toHaveLength(1);
  expect(
    await db.select().from(issueActivity).where(eq(issueActivity.id, comment.id)),
  ).toHaveLength(1);
});
