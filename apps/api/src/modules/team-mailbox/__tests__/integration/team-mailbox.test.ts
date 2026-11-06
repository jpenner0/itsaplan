import { describe, it, expect, beforeEach } from 'bun:test';
import { db, readMailboxSecret, teamMailbox } from '@repo/db';
import { eq } from 'drizzle-orm';
import { authedApi, createProject, type Api } from '#tests/helpers/app';
import { createAgent, teamOf } from '#tests/helpers/agents';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// One mailbox per team, set up by the team's owner or a manager. The credentials are stored
// encrypted and never returned.

const connection = {
  host: '1.1.1.1',
  port: 993,
  secure: true,
  auth: 'password' as const,
  username: 'support@example.com',
  password: 'hunter2',
  allowedSenders: ['@customer.com', 'Boss@Example.com'],
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
  const body = { ...connection, agentId: agent.data!.agent.id };
  return { asOwner, teamId, agentId: agent.data!.agent.id, body };
}

async function addMember(asOwner: Api, teamId: number, role: 'manager' | 'member') {
  const user = await signUpTestUser();
  const invite = await asOwner.teams({ teamId }).invites.post({ email: user.email, role });
  const api = authedApi(user.cookie);
  await api.invites({ token: invite.data!.token }).accept.post();
  return api;
}

describe('team mailbox', () => {
  beforeEach(resetDb);

  it('sets up the mailbox, stores the password encrypted and never returns it', async () => {
    const { asOwner, teamId, body, agentId } = await setup();

    const created = await asOwner.teams({ teamId }).mailbox.post(body);

    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      host: '1.1.1.1',
      auth: 'password',
      hasSecret: true,
      agentId,
      agentName: 'Triage Bot',
      allowedSenders: ['@customer.com', 'boss@example.com'],
      status: 'active',
      lastError: null,
    });
    const read = await asOwner.teams({ teamId }).mailbox.get();
    expect(JSON.stringify(created.data) + JSON.stringify(read.data)).not.toContain('hunter2');
    const [row] = await db.select().from(teamMailbox);
    expect(row!.ciphertext).not.toContain('hunter2');
    expect(row!.redacted).toEqual({ hasSecret: true });
  });

  it('answers 404 without a mailbox and 409 for a second one', async () => {
    const { asOwner, teamId, body } = await setup();
    expect((await asOwner.teams({ teamId }).mailbox.get()).status).toBe(404);
    await asOwner.teams({ teamId }).mailbox.post(body);
    expect((await asOwner.teams({ teamId }).mailbox.post(body)).status).toBe(409);
  });

  it('lets a manager manage it and refuses a member and a non-member', async () => {
    const { asOwner, teamId, body } = await setup();
    const manager = await addMember(asOwner, teamId, 'manager');
    const member = await addMember(asOwner, teamId, 'member');
    const outsider = authedApi((await signUpTestUser()).cookie);

    expect((await manager.teams({ teamId }).mailbox.post(body)).status).toBe(201);
    // A non-member does not see the team at all, so the guard answers 404 for them.
    for (const [who, status] of [
      [member, 403],
      [outsider, 404],
    ] as const) {
      expect((await who.teams({ teamId }).mailbox.get()).status).toBe(status);
      expect((await who.teams({ teamId }).mailbox.post(body)).status).toBe(status);
      expect((await who.teams({ teamId }).mailbox.patch({ port: 143 })).status).toBe(status);
      expect((await who.teams({ teamId }).mailbox.delete()).status).toBe(status);
    }
    expect((await asOwner.teams({ teamId }).mailbox.get()).status).toBe(200);
  });

  it('refuses a private IMAP host on create and when the host changes', async () => {
    const { asOwner, teamId, body } = await setup();
    expect(
      (await asOwner.teams({ teamId }).mailbox.post({ ...body, host: '10.0.0.5' })).status,
    ).toBe(400);
    await asOwner.teams({ teamId }).mailbox.post(body);
    expect((await asOwner.teams({ teamId }).mailbox.patch({ host: '127.0.0.1' })).status).toBe(400);
    expect((await asOwner.teams({ teamId }).mailbox.get()).data?.host).toBe('1.1.1.1');
  });

  it('requires a password, or all three Microsoft 365 values', async () => {
    const { asOwner, teamId, body } = await setup();
    const { password: _p, ...noPassword } = body;
    expect((await asOwner.teams({ teamId }).mailbox.post(noPassword)).status).toBe(400);
    const m365 = { ...noPassword, auth: 'microsoft365' as const, tenantId: 't', clientId: 'c' };
    expect((await asOwner.teams({ teamId }).mailbox.post(m365)).status).toBe(400);
    const ok = await asOwner.teams({ teamId }).mailbox.post({ ...m365, clientSecret: 's3cret' });
    expect(ok.status).toBe(201);
    expect(ok.data).toMatchObject({ auth: 'microsoft365', tenantId: 't', clientId: 'c' });
    expect(JSON.stringify(ok.data)).not.toContain('s3cret');
  });

  it('accepts only an internal agent of the team and valid senders', async () => {
    const { asOwner, teamId, body } = await setup();
    expect(
      (await asOwner.teams({ teamId }).mailbox.post({ ...body, agentId: 999999 })).status,
    ).toBe(400);
    for (const bad of ['nobody', '@', 'a@b', 'two words@x.com']) {
      expect(
        (await asOwner.teams({ teamId }).mailbox.post({ ...body, allowedSenders: [bad] })).status,
      ).toBe(400);
    }
    const empty = await asOwner.teams({ teamId }).mailbox.post({ ...body, allowedSenders: [] });
    expect(empty.data?.allowedSenders).toEqual([]);
  });

  it('keeps the stored secret when an update sends none', async () => {
    const { asOwner, teamId, body } = await setup();
    await asOwner.teams({ teamId }).mailbox.post(body);
    const [before] = await db.select().from(teamMailbox);

    const res = await asOwner
      .teams({ teamId })
      .mailbox.patch({ allowedSenders: ['@other.com'], port: 143, secure: false });

    expect(res.data).toMatchObject({ allowedSenders: ['@other.com'], port: 143, secure: false });
    const [after] = await db.select().from(teamMailbox);
    expect(readMailboxSecret(after!)).toEqual(readMailboxSecret(before!));
  });

  it('restarts a paused mailbox on new credentials and keeps the watermark', async () => {
    const { asOwner, teamId, body } = await setup();
    await asOwner.teams({ teamId }).mailbox.post(body);
    const later = new Date(Date.now() + 3_600_000);
    await db
      .update(teamMailbox)
      .set({
        status: 'paused',
        failures: 5,
        lastError: 'Authentication failed',
        nextPollAt: later,
        uidValidity: 7,
        lastUid: 42,
      })
      .where(eq(teamMailbox.teamId, teamId));
    expect((await asOwner.teams({ teamId }).mailbox.get()).data).toMatchObject({
      status: 'paused',
      lastError: 'Authentication failed',
    });

    const res = await asOwner.teams({ teamId }).mailbox.patch({ password: 'new-pass' });

    expect(res.data).toMatchObject({ status: 'active', lastError: null });
    const [row] = await db.select().from(teamMailbox);
    expect(row).toMatchObject({ failures: 0, uidValidity: 7, lastUid: 42 });
    expect(row!.nextPollAt.getTime()).toBeLessThan(later.getTime());
  });

  it('leaves a paused mailbox paused when only settings change', async () => {
    const { asOwner, teamId, body } = await setup();
    await asOwner.teams({ teamId }).mailbox.post(body);
    await db.update(teamMailbox).set({ status: 'paused' });
    const res = await asOwner.teams({ teamId }).mailbox.patch({ allowedSenders: [] });
    expect(res.data?.status).toBe('paused');
  });

  it('removes the mailbox', async () => {
    const { asOwner, teamId, body } = await setup();
    await asOwner.teams({ teamId }).mailbox.post(body);
    expect((await asOwner.teams({ teamId }).mailbox.delete()).status).toBe(204);
    expect((await asOwner.teams({ teamId }).mailbox.get()).status).toBe(404);
    expect((await asOwner.teams({ teamId }).mailbox.delete()).status).toBe(404);
  });

  it('does not restart a paused mailbox for a field of the other sign-in mode', async () => {
    const { asOwner, teamId, body } = await setup();
    await asOwner.teams({ teamId }).mailbox.post(body);
    await db.update(teamMailbox).set({ status: 'paused' });
    const res = await asOwner.teams({ teamId }).mailbox.patch({ clientSecret: 'ignored' });
    expect(res.data?.status).toBe('paused');
  });

  it('switches the sign-in mode and needs the new credentials', async () => {
    const { asOwner, teamId, body } = await setup();
    await asOwner.teams({ teamId }).mailbox.post(body);
    expect((await asOwner.teams({ teamId }).mailbox.patch({ auth: 'microsoft365' })).status).toBe(
      400,
    );
    const res = await asOwner
      .teams({ teamId })
      .mailbox.patch({ auth: 'microsoft365', tenantId: 't', clientId: 'c', clientSecret: 's' });
    expect(res.data).toMatchObject({ auth: 'microsoft365', tenantId: 't', hasSecret: true });
    const [row] = await db.select().from(teamMailbox);
    expect(readMailboxSecret(row!).password).toBeUndefined();
  });
});
