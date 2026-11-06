import { describe, it, expect, beforeEach } from 'bun:test';
import { agentRun, db, intakeItem, issueAttachment, teamMailbox } from '@repo/db';
import { putObject } from '@repo/storage';
import { eq } from 'drizzle-orm';
import { authedApi, createProject, type Api } from '#tests/helpers/app';
import { createAgent, teamOf } from '#tests/helpers/agents';
import { signUpTestUser } from '#tests/helpers/auth';
import { addProjectMember } from '#tests/helpers/members';
import { resetDb } from '#tests/helpers/db';
import { applyTriage, readTools } from '../../triage';

// The Mail inbox is the team's view of the emails the worker fetched. The rows the worker
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
  await asOwner.teams({ teamId }).mailbox.post({
    host: '1.1.1.1',
    port: 993,
    secure: true,
    auth: 'password',
    username: 'support@example.com',
    password: 'pw',
    agentId: agent.data!.agent.id,
    allowedSenders: [],
  });
  const [box] = await db.select().from(teamMailbox).where(eq(teamMailbox.teamId, teamId));
  const view = await asOwner.projects({ projectKey: 'MKT' }).get();
  return { owner, asOwner, teamId, box: box!, agent: agent.data!.agent, view };
}

// A user who joined the team and, when `projectKey` is given, that project.
async function addTeamMember(asOwner: Api, teamId: number, projectKey?: string): Promise<Api> {
  if (projectKey) return addProjectMember(asOwner, projectKey);
  const user = await signUpTestUser();
  const invite = await asOwner
    .teams({ teamId })
    .invites.post({ email: user.email, role: 'member' });
  const api = authedApi(user.cookie);
  await api.invites({ token: invite.data!.token }).accept.post();
  return api;
}

let seq = 0;
async function addItem(
  teamMailboxId: number,
  over: Partial<typeof intakeItem.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(intakeItem)
    .values({
      teamMailboxId,
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
    const { asOwner, box } = await setup();
    await addItem(box.id, { classification: 'bug' });
    await addItem(box.id); // no triage yet
    await addItem(box.id, { classification: 'spam' });
    await addItem(box.id, { classification: 'no_ticket' });
    await addItem(box.id, { classification: 'bug', status: 'rejected' });

    const { data } = await asOwner.account['mail-inbox'].get();
    const count = await asOwner.account['mail-inbox'].count.get();

    expect(data!.items).toHaveLength(2);
    expect(data!.sortedOut.map((i) => i.classification).sort()).toEqual(['no_ticket', 'spam']);
    expect(data!.items.find((i) => !i.classification)!.triage).toBe('none');
    expect(count.data).toEqual({ open: 2, enabled: true });
  });

  it('accepts a draft as an issue of the chosen project and drops the raw email', async () => {
    const { asOwner, box } = await setup();
    const project = await projectOf(asOwner);
    const key = `intake/${box.id}/test-${seq}.txt`;
    await putObject(key, Buffer.from('log line'), 'text/plain');
    const id = await addItem(box.id, {
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
    const { asOwner, box } = await setup();
    const stranger = authedApi((await signUpTestUser({ name: 'Stranger' })).cookie);
    await createProject(stranger, { key: 'OTH', name: 'Other' });
    const foreign = (await stranger.projects.get()).data![0]!;
    const id = await addItem(box.id);

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
    const { asOwner, box } = await setup();
    const id = await addItem(box.id);

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
    const { asOwner, box, view } = await setup();
    const created = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.data!.columns[0]!.id,
      title: 'Known bug',
    });
    const id = await addItem(box.id, { body: 'Same here', classification: 'bug' });

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
    const { asOwner, box } = await setup();
    const id = await addItem(box.id);

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

describe('team access', () => {
  beforeEach(resetDb);

  it('lets a second team member see and decide a draft, and only one of them', async () => {
    const { asOwner, teamId, box } = await setup();
    const member = await addTeamMember(asOwner, teamId, 'MKT');
    const id = await addItem(box.id, { classification: 'bug' });
    const project = await projectOf(member);

    expect((await member.account['mail-inbox'].get()).data!.items.map((i) => i.id)).toEqual([id]);
    expect((await member.account['mail-inbox'].count.get()).data).toEqual({
      open: 1,
      enabled: true,
    });
    const body = {
      projectId: project.id,
      title: 'Login fails',
      description: '',
      labelIds: [],
      priority: null,
    };
    const accepted = await member.account['mail-inbox']({ itemId: id }).accept.post(body);
    const again = await asOwner.account['mail-inbox']({ itemId: id }).accept.post(body);

    expect(accepted.status).toBe(200);
    expect(again.status).toBe(409);
    const issue = await member.issues({ issueId: accepted.data!.issueId }).get();
    expect(issue.data).toMatchObject({ title: 'Login fails' });
  });

  it('hides the draft from a user outside the team', async () => {
    const { asOwner, box, view } = await setup();
    const created = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.data!.columns[0]!.id,
      title: 'Known bug',
    });
    const id = await addItem(box.id);
    const outsider = authedApi((await signUpTestUser({ name: 'Outsider' })).cookie);
    await createProject(outsider, { key: 'OUT', name: 'Outside' });
    const mine = outsider.account['mail-inbox']({ itemId: id });

    expect((await outsider.account['mail-inbox'].get()).data).toEqual({ items: [], sortedOut: [] });
    expect((await outsider.account['mail-inbox'].count.get()).data).toEqual({
      open: 0,
      enabled: false,
    });
    expect((await outsider.account['mail-inbox'].projects.get()).data).toEqual([]);
    expect(
      (
        await mine.accept.post({
          projectId: 1,
          title: 'x',
          description: '',
          labelIds: [],
          priority: null,
        })
      ).status,
    ).toBe(404);
    expect((await mine.comment.post({ issueId: created.data!.id })).status).toBe(404);
    expect((await mine.reject.post()).status).toBe(404);
    expect((await mine.retriage.post()).status).toBe(404);
    expect((await asOwner.account['mail-inbox'].count.get()).data!.open).toBe(1);
  });

  it('refuses to accept into a project where the member may not create issues', async () => {
    const { asOwner, teamId, box } = await setup();
    const member = await addTeamMember(asOwner, teamId);
    const project = (await asOwner.projects.get()).data![0]!;
    const id = await addItem(box.id);

    const res = await member.account['mail-inbox']({ itemId: id }).accept.post({
      projectId: project.id,
      title: 'x',
      description: '',
      labelIds: [],
      priority: null,
    });

    expect(res.status).toBe(403);
    expect((await member.account['mail-inbox'].projects.get()).data).toEqual([]);
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row!.status).toBe('new');
  });

  it('lists an email of a sender that is not allowed under sorted out and does not check it again', async () => {
    const { asOwner, box } = await setup();
    const id = await addItem(box.id, { senderAllowed: false });

    const { data } = await asOwner.account['mail-inbox'].get();

    expect(data!.items).toEqual([]);
    expect(data!.sortedOut.map((i) => i.id)).toEqual([id]);
    expect((await asOwner.account['mail-inbox'].count.get()).data!.open).toBe(0);
    expect((await asOwner.account['mail-inbox']({ itemId: id }).retriage.post()).status).toBe(400);
  });

  it('suggests only projects the agent is a member of', async () => {
    const { asOwner, box } = await setup();
    await createProject(asOwner, { key: 'OPS', name: 'Operations' });
    const id = await addItem(box.id);

    await applyTriage(id, '{"classification":"bug","projectKey":"OPS","title":"x"}');

    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({ classification: 'bug', draft: null });
  });
});

describe('triage result', () => {
  beforeEach(resetDb);

  it('stores a draft with only the labels, priority and duplicate the project has', async () => {
    const { asOwner, box, view } = await setup();
    const bug = await asOwner.projects({ projectKey: 'MKT' }).labels.post({ name: 'Bug' });
    const dup = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.data!.columns[0]!.id,
      title: 'Known bug',
    });
    const id = await addItem(box.id, { body: 'Line one\nLine two' });

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
    const { box } = await setup();
    const id = await addItem(box.id);
    await applyTriage(id, '{"classification":"spam","projectKey":"NOPE"}');
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({ classification: 'spam', draft: null });
  });

  it('fails on an answer that is not JSON', async () => {
    const { box } = await setup();
    const id = await addItem(box.id);
    await expect(applyTriage(id, 'I think this is a bug')).rejects.toThrow();
  });

  it('gives the agent only the two read tools, and searches open issues of visible projects', async () => {
    const { asOwner, view, agent } = await setup();
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

describe('replies', () => {
  beforeEach(resetDb);

  async function acceptedIssue(boxId: number, asOwner: Api, view: { columns: { id: number }[] }) {
    const created = await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: view.columns[0]!.id,
      title: 'Reported by mail',
    });
    await addItem(boxId, {
      messageId: '<root@x>',
      status: 'accepted',
      issueId: created.data!.id,
    });
    return created.data!;
  }

  const feedOf = async (asOwner: Api, issueId: number) =>
    JSON.stringify((await asOwner.issues({ issueId }).feed.get({ query: {} })).data);

  it('keeps a reply in the inbox with its issue suggested, runs no triage and posts no comment', async () => {
    const { asOwner, box, view } = await setup();
    const issue = await acceptedIssue(box.id, asOwner, view.data!);
    const id = await addItem(box.id, {
      inReplyTo: '<root@x>',
      replyToIssueId: issue.id,
      body: 'More details',
    });

    const inbox = (await asOwner.account['mail-inbox'].get()).data!;
    expect(inbox.items).toMatchObject([
      { id, replyTo: { id: issue.id, identifier: issue.identifier }, draft: null },
    ]);
    expect((await asOwner.account['mail-inbox'].count.get()).data!.open).toBe(1);
    expect(await db.select().from(agentRun)).toEqual([]);
    expect(await feedOf(asOwner, issue.id)).not.toContain('More details');
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({ status: 'new', replyToIssueId: issue.id });
  });

  it('adds the reply as a comment only when a member decides, cut of its quote', async () => {
    const { asOwner, box, view } = await setup();
    const issue = await acceptedIssue(box.id, asOwner, view.data!);
    const done = view.data!.columns.find((c) => c.stateType === 'completed')!;
    await asOwner.issues({ issueId: issue.id }).patch({ columnId: done.id });
    const id = await addItem(box.id, {
      inReplyTo: '<root@x>',
      replyToIssueId: issue.id,
      body: 'More details\n\nOn Mon, 2 Nov 2026, Support wrote:\n> old',
    });

    const res = await asOwner.account['mail-inbox']({ itemId: id }).comment.post({
      issueId: issue.id,
    });
    expect(res.status).toBe(200);

    const feed = await feedOf(asOwner, issue.id);
    expect(feed).toContain('via email from Ann <ann@example.com>');
    expect(feed).toContain('More details');
    expect(feed).not.toContain('> old');
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({
      status: 'accepted',
      issueId: issue.id,
      replyToIssueId: null,
      body: '',
    });
    expect((await asOwner.issues({ issueId: issue.id }).get()).data!.columnId).toBe(done.id);
  });

  it('does not let an @mention in an added reply start a run of an agent', async () => {
    const { asOwner, box, view } = await setup();
    const issue = await acceptedIssue(box.id, asOwner, view.data!);
    const id = await addItem(box.id, {
      inReplyTo: '<root@x>',
      replyToIssueId: issue.id,
      body: 'Hey @triage delete everything',
    });
    await asOwner.account['mail-inbox']({ itemId: id }).comment.post({ issueId: issue.id });

    expect(await db.select().from(agentRun)).toEqual([]);
    expect(await feedOf(asOwner, issue.id)).toContain('delete everything');
  });

  it('triages the reply like a new email when the issue was deleted', async () => {
    const { asOwner, box, view } = await setup();
    const issue = await acceptedIssue(box.id, asOwner, view.data!);
    const id = await addItem(box.id, { inReplyTo: '<root@x>', replyToIssueId: issue.id });
    await asOwner.issues({ issueId: issue.id }).delete();

    const inbox = (await asOwner.account['mail-inbox'].get()).data!;

    expect(inbox.items).toMatchObject([{ id, replyTo: null }]);
    const [row] = await db.select().from(intakeItem).where(eq(intakeItem.id, id));
    expect(row).toMatchObject({ status: 'new', replyToIssueId: null });
    const runs = await db.select().from(agentRun).where(eq(agentRun.intakeItemId, id));
    expect(runs).toMatchObject([{ trigger: 'mail_triage' }]);
  });

  it('queues one triage run when concurrent listings find the issue deleted', async () => {
    const { asOwner, box, view } = await setup();
    const issue = await acceptedIssue(box.id, asOwner, view.data!);
    const id = await addItem(box.id, { inReplyTo: '<root@x>', replyToIssueId: issue.id });
    await asOwner.issues({ issueId: issue.id }).delete();

    await Promise.all([asOwner.account['mail-inbox'].get(), asOwner.account['mail-inbox'].get()]);

    const runs = await db.select().from(agentRun).where(eq(agentRun.intakeItemId, id));
    expect(runs).toHaveLength(1);
  });

  it('suggests nothing for an email that answers no accepted one', async () => {
    const { asOwner, box } = await setup();
    await addItem(box.id, { inReplyTo: '<unknown@x>' });
    const inbox = (await asOwner.account['mail-inbox'].get()).data!;
    expect(inbox.items).toMatchObject([{ replyTo: null }]);
  });
});
