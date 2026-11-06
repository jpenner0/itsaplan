import { describe, it, expect, beforeEach } from 'bun:test';
import { agentRun, db, intakeItem, issueAttachment, mailboxFolder } from '@repo/db';
import { putObject } from '@repo/storage';
import { eq } from 'drizzle-orm';
import { authedApi, createProject, type Api } from '#tests/helpers/app';
import { createAgent, teamOf } from '#tests/helpers/agents';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { applyTriage, readTools } from '../../triage';

// The Mail inbox is the owner's view of the emails the worker fetched. The rows the worker
// writes are inserted directly: there is no IMAP server to call. Everything else goes through
// the API.

async function setup() {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  const teamId = await teamOf(asOwner, 'MKT');
  const agent = await createAgent(asOwner, 'MKT', {
    name: 'Triage Bot',
    username: 'triage',
    kind: 'internal',
  });
  const box = await asOwner.account.mailboxes.post({
    label: 'Support',
    host: '1.1.1.1',
    port: 993,
    secure: true,
    auth: 'password',
    username: 'support@example.com',
    password: 'pw',
  });
  const withFolder = await asOwner.account
    .mailboxes({ mailboxId: box.data!.id })
    .folders.post({ name: 'INBOX', teamId, agentId: agent.data!.agent.id });
  const [folder] = await db
    .select()
    .from(mailboxFolder)
    .where(eq(mailboxFolder.id, withFolder.data!.folders[0]!.id));
  const view = await asOwner.projects({ projectKey: 'MKT' }).get();
  return { owner, asOwner, teamId, folder: folder!, agent: agent.data!.agent, view };
}

let seq = 0;
async function addItem(
  folderId: number,
  over: Partial<typeof intakeItem.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(intakeItem)
    .values({
      folderId,
      messageId: `<m${++seq}@x>`,
      fromName: 'Ann',
      fromAddress: 'ann@example.com',
      subject: 'Login broken',
      body: 'I cannot log in.',
      ...over,
    })
    .returning({ id: intakeItem.id });
  return row!.id;
}

async function projectOf(asOwner: Api) {
  const projects = (await asOwner.account['mail-inbox'].projects.get()).data!;
  return projects[0]!;
}

describe('mail inbox', () => {
  beforeEach(resetDb);

  it('lists open drafts, keeps spam and no-ticket under sorted out and counts the open ones', async () => {
    const { asOwner, folder } = await setup();
    await addItem(folder.id, { classification: 'bug' });
    await addItem(folder.id); // no triage yet
    await addItem(folder.id, { classification: 'spam' });
    await addItem(folder.id, { classification: 'no_ticket' });
    await addItem(folder.id, { classification: 'bug', status: 'rejected' });

    const { data } = await asOwner.account['mail-inbox'].get();
    const count = await asOwner.account['mail-inbox'].count.get();

    expect(data!.items).toHaveLength(2);
    expect(data!.sortedOut.map((i) => i.classification).sort()).toEqual(['no_ticket', 'spam']);
    expect(data!.items.find((i) => !i.classification)!.triage).toBe('none');
    expect(count.data).toEqual({ open: 2, enabled: true });
  });

  it('shows an email only to the owner of its mailbox', async () => {
    const { asOwner, folder } = await setup();
    const id = await addItem(folder.id);
    const other = authedApi((await signUpTestUser({ name: 'Other' })).cookie);

    expect((await other.account['mail-inbox'].get()).data).toEqual({ items: [], sortedOut: [] });
    const res = await other.account['mail-inbox']({ itemId: id }).reject.post();
    expect(res.status).toBe(404);
    expect((await asOwner.account['mail-inbox'].count.get()).data).toEqual({
      open: 1,
      enabled: true,
    });
  });

  it('accepts a draft as an issue of the chosen project and drops the raw email', async () => {
    const { asOwner, folder } = await setup();
    const project = await projectOf(asOwner);
    const key = `intake/${folder.id}/test-${seq}.txt`;
    await putObject(key, Buffer.from('log line'), 'text/plain');
    const id = await addItem(folder.id, {
      classification: 'bug',
      attachments: [
        { filename: 'log.txt', contentType: 'text/plain', sizeBytes: 8, s3Key: key },
        {
          filename: 'huge.zip',
          contentType: 'application/zip',
          sizeBytes: 90_000_000,
          s3Key: null,
        },
      ],
    });
    const label = await asOwner.projects({ projectKey: 'MKT' }).labels.post({ name: 'bug' });

    const res = await asOwner.account['mail-inbox']({ itemId: id }).accept.post({
      projectId: project.id,
      title: 'Login fails',
      description: 'User cannot log in',
      labelIds: [label.data!.id],
      priority: 'high',
    });

    expect(res.status).toBe(200);
    expect(res.data!.identifier).toStartWith('MKT-');
    const issue = await asOwner.issues({ issueId: res.data!.issueId }).get();
    expect(issue.data).toMatchObject({
      title: 'Login fails',
      priority: 'high',
      labelIds: [label.data!.id],
    });
    expect(issue.data!.description).toContain('User cannot log in');
    expect(issue.data!.description).toContain('Attachment not stored: huge.zip');
    const files = await db
      .select({ name: issueAttachment.filename })
      .from(issueAttachment)
      .where(eq(issueAttachment.issueId, res.data!.issueId));
    expect(files).toEqual([{ name: 'log.txt' }]);
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({
      status: 'accepted',
      issueId: res.data!.issueId,
      body: '',
      attachments: [],
      messageId: expect.stringContaining('@x>'),
      fromAddress: 'ann@example.com',
    });
    const again = await asOwner.account['mail-inbox']({ itemId: id }).accept.post({
      projectId: project.id,
      title: 'x',
      description: '',
      labelIds: [],
      priority: null,
    });
    expect(again.status).toBe(409);
  });

  it('refuses a project of another team', async () => {
    const { asOwner, folder } = await setup();
    const stranger = authedApi((await signUpTestUser({ name: 'Stranger' })).cookie);
    await createProject(stranger, { key: 'OTH', name: 'Other' });
    const foreign = (await stranger.projects.get()).data![0]!;
    const id = await addItem(folder.id);

    const res = await asOwner.account['mail-inbox']({ itemId: id }).accept.post({
      projectId: foreign.id,
      title: 'x',
      description: '',
      labelIds: [],
      priority: null,
    });

    expect(res.status).toBe(400);
  });

  it('rejects a draft and keeps it for the retention period', async () => {
    const { asOwner, folder } = await setup();
    const id = await addItem(folder.id);

    expect((await asOwner.account['mail-inbox']({ itemId: id }).reject.post()).status).toBe(204);

    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row!.status).toBe('rejected');
    expect(row!.decidedAt).not.toBeNull();
    expect((await asOwner.account['mail-inbox'].count.get()).data).toEqual({
      open: 0,
      enabled: true,
    });
    expect((await asOwner.account['mail-inbox']({ itemId: id }).reject.post()).status).toBe(409);
  });

  it('adds the email as a comment on an issue of the team', async () => {
    const { asOwner, folder, view } = await setup();
    const created = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.data!.columns[0]!.id,
      title: 'Known bug',
    });
    const id = await addItem(folder.id, { body: 'Same here', classification: 'bug' });

    const res = await asOwner.account['mail-inbox']({ itemId: id }).comment.post({
      issueId: created.data!.id,
    });

    expect(res.status).toBe(200);
    const feed = await asOwner.issues({ issueId: created.data!.id }).feed.get({ query: {} });
    expect(JSON.stringify(feed.data)).toContain('via email from Ann <ann@example.com>');
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({ status: 'accepted', issueId: created.data!.id });
  });

  it('queues the check again once, and not while one is pending', async () => {
    const { asOwner, folder } = await setup();
    const id = await addItem(folder.id);

    const first = await asOwner.account['mail-inbox']({ itemId: id }).retriage.post();
    const second = await asOwner.account['mail-inbox']({ itemId: id }).retriage.post();

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    const runs = await db.select().from(agentRun).where(eq(agentRun.intakeItemId, id));
    expect(runs).toMatchObject([{ trigger: 'mail_triage', status: 'pending' }]);
    const item = (await asOwner.account['mail-inbox'].get()).data!.items[0]!;
    expect(item.triage).toBe('pending');
  });
});

describe('triage result', () => {
  beforeEach(resetDb);

  it('stores a draft with only the labels, priority and duplicate the project has', async () => {
    const { asOwner, folder, view } = await setup();
    const bug = await asOwner.projects({ projectKey: 'MKT' }).labels.post({ name: 'Bug' });
    const dup = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.data!.columns[0]!.id,
      title: 'Known bug',
    });
    const id = await addItem(folder.id, { body: 'Line one\nLine two' });

    await applyTriage(
      id,
      '```json\n' +
        JSON.stringify({
          classification: 'bug',
          projectKey: 'mkt',
          title: 'Login fails',
          summary: 'Cannot log in',
          labels: ['bug', 'does-not-exist'],
          priority: 'critical',
          duplicateOf: dup.data!.identifier,
        }) +
        '\n```',
    );

    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row!.classification).toBe('bug');
    expect(row!.draft).toMatchObject({
      title: 'Login fails',
      labelIds: [bug.data!.id],
      priority: null,
      duplicateIssueId: dup.data!.id,
    });
    expect(row!.draft!.description).toContain('Cannot log in');
    expect(row!.draft!.description).toContain('> Line two');
  });

  it('keeps no draft when the project is not one the agent may suggest', async () => {
    const { folder } = await setup();
    const id = await addItem(folder.id);
    await applyTriage(id, '{"classification":"spam","projectKey":"NOPE"}');
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({ classification: 'spam', draft: null });
  });

  it('fails on an answer that is not JSON', async () => {
    const { folder } = await setup();
    const id = await addItem(folder.id);
    await expect(applyTriage(id, 'I think this is a bug')).rejects.toThrow();
  });

  it('gives the agent only the two read tools, and searches open issues of visible projects', async () => {
    const { asOwner, folder, view, agent } = await setup();
    const open = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.data!.columns[0]!.id,
      title: 'Printer jams',
    });
    const done = view.data!.columns.find((c) => c.stateType === 'completed')!;
    await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: done.id,
      title: 'Printer jams (fixed)',
    });
    const project = await projectOf(asOwner);
    const tools = readTools(
      [{ id: project.id, key: 'MKT', name: 'Marketing', description: '', labels: [] }],
      agent.userId,
    );
    void folder;

    expect(Object.keys(tools).sort()).toEqual(['get_issue', 'search_issues']);
    const hits = await tools.search_issues.execute!(
      { projectKey: 'MKT', query: 'printer' },
      {} as never,
    );
    expect(hits).toEqual([{ identifier: open.data!.identifier, title: 'Printer jams' }]);
    const other = await tools.search_issues.execute!(
      { projectKey: 'OTH', query: 'printer' },
      {} as never,
    );
    expect(other).toEqual({ error: 'Project not found' });
  });
});
