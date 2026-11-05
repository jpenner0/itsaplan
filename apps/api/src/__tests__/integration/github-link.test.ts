import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { account, db } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { app, authedApi } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// GitHub links an identity to a signed-in account for the issue sync and is never a
// way in. GitHub's endpoints are fixed, so they are answered here.
const realFetch = globalThis.fetch;
function answerGithub() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'gho_token', token_type: 'bearer', scope: 'read:user' });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({
        id: 4242,
        login: 'octo',
        name: 'Octo Cat',
        email: 'octo@github.example',
        avatar_url: 'https://avatars.example/4242',
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

// The better-auth endpoints are not modelled by Eden Treaty, so they are driven
// through the app handler.
function post(path: string, body: object, cookie = '') {
  return app.handle(
    new Request(`http://localhost/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function configureGithub(cookie: string, enabled = true) {
  const res = await authedApi(cookie).god['github-settings'].put({
    enabled,
    clientId: 'github-client',
    clientSecret: 'github-secret',
  });
  expect(res.status).toBe(200);
}

// The whole link round trip, as the browser of the signed-in person makes it.
async function linkGithub(cookie: string) {
  answerGithub();
  const start = await post(
    '/link-social',
    { provider: 'github', callbackURL: 'http://localhost:3001/account/accounts' },
    cookie,
  );
  expect(start.status).toBe(200);
  const authorize = new URL(((await start.json()) as { url: string }).url);
  const callback = await app.handle(
    new Request(
      `http://localhost/api/auth/callback/github?code=code-1&state=${authorize.searchParams.get('state')}`,
      { headers: { cookie: `${cookie}; ${cookiesOf(start)}` } },
    ),
  );
  return { authorize, callback };
}

function rowsOf(userId: string) {
  return db.select().from(account).where(eq(account.userId, userId));
}

describe('GitHub account link', () => {
  beforeEach(resetDb);
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('links the GitHub user id to the signed-in account and keeps no token', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    const member = await signUpTestUser({ name: 'Member' });

    const { authorize, callback } = await linkGithub(member.cookie);

    expect(authorize.searchParams.get('scope')).toBe('read:user');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('http://localhost:3001/account/accounts');
    const rows = await db
      .select()
      .from(account)
      .where(and(eq(account.userId, member.userId), eq(account.providerId, 'github')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: '4242',
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
  });

  // A link started by one person and completed in another's browser would attach the
  // second person's GitHub identity to the first person's account.
  it('refuses a callback from a browser that did not start the link', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    const attacker = await signUpTestUser({ name: 'Attacker' });
    answerGithub();

    const start = await post(
      '/link-social',
      { provider: 'github', callbackURL: 'http://localhost:3001/account/accounts' },
      attacker.cookie,
    );
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state');
    const callback = await app.handle(
      new Request(`http://localhost/api/auth/callback/github?code=code-1&state=${state}`, {
        headers: { cookie: god.cookie },
      }),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('error=');
    expect(await db.select().from(account).where(eq(account.providerId, 'github'))).toHaveLength(0);
  });

  it('refuses a second GitHub account while one is linked', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    await linkGithub(god.cookie);

    const res = await post(
      '/link-social',
      { provider: 'github', callbackURL: 'http://localhost:3001/account/accounts' },
      god.cookie,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_ALREADY_LINKED' });
    expect((await rowsOf(god.userId)).filter((r) => r.providerId === 'github')).toHaveLength(1);
  });

  it('refuses to unlink the last way to sign in while GitHub is linked', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    await linkGithub(god.cookie);
    const password = (await rowsOf(god.userId)).find((r) => r.providerId === 'credential')!;

    const res = await post('/unlink-account', { accountId: password.id }, god.cookie);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
    expect(await rowsOf(god.userId)).toHaveLength(2);
  });

  it('unlinks a sign-in method while another one is left', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    await linkGithub(god.cookie);
    // A Google sign-in needs Google's round trip; the row is what the rule reads.
    await db.insert(account).values({
      id: 'google-row',
      accountId: 'google-sub',
      providerId: 'google',
      userId: god.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const password = (await rowsOf(god.userId)).find((r) => r.providerId === 'credential')!;

    const res = await post('/unlink-account', { accountId: password.id }, god.cookie);

    expect(res.status).toBe(200);
    expect((await rowsOf(god.userId)).map((r) => r.providerId).sort()).toEqual([
      'github',
      'google',
    ]);
  });

  it('unlinks GitHub', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    await linkGithub(god.cookie);
    const github = (await rowsOf(god.userId)).find((r) => r.providerId === 'github')!;

    const res = await post('/unlink-account', { accountId: github.id }, god.cookie);

    expect(res.status).toBe(200);
    expect((await rowsOf(god.userId)).map((r) => r.providerId)).toEqual(['credential']);
  });

  it('refuses a sign-in or sign-up with GitHub', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);

    const res = await post('/sign-in/social', {
      provider: 'github',
      callbackURL: 'http://localhost:3001/',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_SIGN_IN_DISABLED' });
  });

  it('refuses a link while GitHub is turned off', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie, false);

    const res = await post(
      '/link-social',
      { provider: 'github', callbackURL: 'http://localhost:3001/account/accounts' },
      god.cookie,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_DISABLED' });
  });
});
