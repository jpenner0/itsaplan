import { describe, it, expect, beforeEach } from 'bun:test';
import { db, mailbox, mailboxFolder } from '@repo/db';
import { eq } from 'drizzle-orm';
import { authedApi, createProject } from '#tests/helpers/app';
import { createAgent, teamOf } from '#tests/helpers/agents';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// A mailbox belongs to its user. The credentials are stored encrypted and never returned.
// A folder takes a team the user belongs to and an internal agent of that team.

const connection = {
  label: 'Support',
  host: '1.1.1.1',
  port: 993,
  secure: true,
  auth: 'password' as const,
  username: 'support@example.com',
  password: 'hunter2',
};

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
  return { owner, asOwner, teamId, agentId: agent.data!.agent.id };
}

describe('mailboxes', () => {
  beforeEach(resetDb);

  it('connects a mailbox, stores the password encrypted and never returns it', async () => {
    const { asOwner } = await setup();

    const created = await asOwner.account.mailboxes.post(connection);

    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      label: 'Support',
      host: '1.1.1.1',
      auth: 'password',
      hasSecret: true,
      folders: [],
    });
    expect(JSON.stringify(created.data)).not.toContain('hunter2');
    const [row] = await db.select().from(mailbox);
    expect(row!.ciphertext).not.toContain('hunter2');
    expect(row!.redacted).toEqual({ hasSecret: true });
  });

  it('refuses a private IMAP host', async () => {
    const { asOwner } = await setup();
    const res = await asOwner.account.mailboxes.post({ ...connection, host: '10.0.0.5' });
    expect(res.status).toBe(400);
  });

  it('requires a password for password sign-in and all three ids for Microsoft 365', async () => {
    const { asOwner } = await setup();
    const { password: _password, ...noPassword } = connection;
    expect((await asOwner.account.mailboxes.post(noPassword)).status).toBe(400);
    const m365 = { ...noPassword, auth: 'microsoft365' as const, tenantId: 't', clientId: 'c' };
    expect((await asOwner.account.mailboxes.post(m365)).status).toBe(400);
    const ok = await asOwner.account.mailboxes.post({ ...m365, clientSecret: 's' });
    expect(ok.status).toBe(201);
    expect(ok.data).toMatchObject({ auth: 'microsoft365', tenantId: 't', clientId: 'c' });
  });

  it('shows a mailbox only to its owner', async () => {
    const { asOwner } = await setup();
    const created = await asOwner.account.mailboxes.post(connection);
    const other = authedApi((await signUpTestUser({ name: 'Other' })).cookie);

    expect((await other.account.mailboxes.get()).data).toEqual([]);
    const res = await other.account
      .mailboxes({ mailboxId: created.data!.id })
      .patch({ label: 'x' });
    expect(res.status).toBe(404);
    expect((await other.account.mailboxes({ mailboxId: created.data!.id }).delete()).status).toBe(
      404,
    );
  });

  it('adds a folder of a team the user belongs to with an internal agent of that team', async () => {
    const { asOwner, teamId, agentId } = await setup();
    const box = await asOwner.account.mailboxes.post(connection);

    const res = await asOwner.account
      .mailboxes({ mailboxId: box.data!.id })
      .folders.post({ name: 'INBOX/Support', teamId, agentId });

    expect(res.status).toBe(201);
    expect(res.data!.folders).toMatchObject([
      { name: 'INBOX/Support', teamId, agentId, status: 'active', agentName: 'Triage Bot' },
    ]);
    const again = await asOwner.account
      .mailboxes({ mailboxId: box.data!.id })
      .folders.post({ name: 'INBOX/Support', teamId, agentId });
    expect(again.status).toBe(409);
  });

  it('refuses a team the user is not in and an agent of another team', async () => {
    const { asOwner, teamId, agentId } = await setup();
    const stranger = authedApi((await signUpTestUser({ name: 'Stranger' })).cookie);
    await createProject(stranger, { key: 'OTH', name: 'Other' });
    const strangerTeam = await teamOf(stranger, 'OTH');
    const box = await asOwner.account.mailboxes.post(connection);
    const folders = asOwner.account.mailboxes({ mailboxId: box.data!.id }).folders;

    expect((await folders.post({ name: 'INBOX', teamId: strangerTeam, agentId })).status).toBe(403);
    expect((await folders.post({ name: 'INBOX', teamId, agentId: agentId + 999 })).status).toBe(
      400,
    );
  });

  it("offers only the user's teams and their internal agents", async () => {
    const { asOwner, teamId, agentId } = await setup();
    const stranger = authedApi((await signUpTestUser({ name: 'Stranger' })).cookie);
    await createProject(stranger, { key: 'OTH', name: 'Other' });

    const { data } = await asOwner.account.mailboxes.options.get();

    expect(data!.teams.map((x) => x.id)).toEqual([teamId]);
    expect(data!.teams[0]!.agents.map((a) => a.id)).toEqual([agentId]);
  });

  it('starts a paused folder again when the password is replaced', async () => {
    const { asOwner, teamId, agentId } = await setup();
    const box = await asOwner.account.mailboxes.post(connection);
    const id = box.data!.id;
    const added = await asOwner.account.mailboxes({ mailboxId: id }).folders.post({
      name: 'INBOX',
      teamId,
      agentId,
    });
    await db
      .update(mailboxFolder)
      .set({ status: 'paused', failures: 3, lastError: 'Invalid credentials' })
      .where(eq(mailboxFolder.id, added.data!.folders[0]!.id));

    const label = await asOwner.account.mailboxes({ mailboxId: id }).patch({ label: 'Renamed' });
    expect(label.data!.folders[0]!.status).toBe('paused');

    const res = await asOwner.account.mailboxes({ mailboxId: id }).patch({ password: 'new' });

    expect(res.status).toBe(200);
    expect(res.data!.folders[0]).toMatchObject({ status: 'active', lastError: null });
  });

  it('deletes a mailbox with its folders', async () => {
    const { asOwner, teamId, agentId } = await setup();
    const box = await asOwner.account.mailboxes.post(connection);
    await asOwner.account.mailboxes({ mailboxId: box.data!.id }).folders.post({
      name: 'INBOX',
      teamId,
      agentId,
    });

    expect((await asOwner.account.mailboxes({ mailboxId: box.data!.id }).delete()).status).toBe(
      204,
    );

    expect(await db.select().from(mailboxFolder)).toEqual([]);
  });
});
