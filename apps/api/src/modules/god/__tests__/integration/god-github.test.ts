import { describe, expect, it, beforeEach } from 'bun:test';
import { appSecret, db } from '@repo/db';
import { eq } from 'drizzle-orm';
import { api } from '#tests/helpers/app';
import { resetDb } from '#tests/helpers/db';
import { addUser, setup } from '../helpers';

const credentials = { clientId: 'Iv1.github-client', clientSecret: 'github-secret' };

describe('god GitHub settings', () => {
  beforeEach(resetDb);

  it('refuses a plain user', async () => {
    await setup();
    const user = await addUser({ email: 'someone@example.com' });

    expect((await user.api.god['github-settings'].get()).status).toBe(403);
    expect((await user.api.god['github-settings'].put({ enabled: false })).status).toBe(403);
  });

  it('reports an unconfigured app with the callback URL to register', async () => {
    const { god } = await setup();

    const res = await god.api.god['github-settings'].get();

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      enabled: false,
      clientId: '',
      hasClientSecret: false,
      redirectUri: 'http://localhost:3000/api/auth/callback/github',
    });
  });

  it('stores the secret encrypted and never returns it', async () => {
    const { god } = await setup();

    const saved = await god.api.god['github-settings'].put({ ...credentials, enabled: true });

    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({
      enabled: true,
      clientId: credentials.clientId,
      hasClientSecret: true,
    });
    expect(JSON.stringify(saved.data)).not.toContain(credentials.clientSecret);
    const [row] = await db.select().from(appSecret).where(eq(appSecret.key, 'auth.github'));
    expect(JSON.stringify(row)).not.toContain(credentials.clientSecret);
    expect(row?.redacted).toEqual({
      enabled: true,
      clientId: credentials.clientId,
      hasClientSecret: true,
    });
  });

  it('keeps the stored secret when the field is sent empty', async () => {
    const { god } = await setup();
    await god.api.god['github-settings'].put({ ...credentials, enabled: true });

    const saved = await god.api.god['github-settings'].put({ clientSecret: '', enabled: false });

    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ enabled: false, hasClientSecret: true });
  });

  it('refuses to turn linking on without both credentials', async () => {
    const { god } = await setup();

    const res = await god.api.god['github-settings'].put({
      enabled: true,
      clientId: credentials.clientId,
    });

    expect(res.status).toBe(400);
    expect((await god.api.god['github-settings'].get()).data?.enabled).toBe(false);
  });

  it('tells the profile whether GitHub can be linked', async () => {
    const { god } = await setup();
    expect((await api['auth-config'].get()).data).toMatchObject({ github: false });

    await god.api.god['github-settings'].put({ ...credentials, enabled: true });

    expect((await api['auth-config'].get()).data).toMatchObject({ github: true });
  });
});
