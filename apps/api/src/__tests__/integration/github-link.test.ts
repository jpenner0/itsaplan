import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { account, db } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { app, authedApi } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

// GitHub signs people in and links an identity to a signed-in account for the issue
// sync. GitHub's endpoints are fixed, so they are answered here.
let emails = [{ email: 'octo@github.example', primary: true, verified: true }];
const realFetch = globalThis.fetch;
function answerGithub() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      const code = new URLSearchParams(String(init?.body)).get('code');
      return Response.json({
        access_token: `gho_${code}`,
        token_type: 'bearer',
        scope: 'read:user',
      });
    }
    if (url === 'https://api.github.com/user') {
      const token = new Headers(init?.headers).get('authorization');
      return Response.json({
        id: token?.endsWith('code-2') ? 4343 : 4242,
        login: 'octo',
        name: 'Octo Cat',
        email: 'octo@github.example',
        avatar_url: 'https://avatars.example/4242',
      });
    }
    if (url === 'https://api.github.com/user/emails') return Response.json(emails);
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
    emails = [{ email: 'octo@github.example', primary: true, verified: true }];
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

  it('links one GitHub account when two flows were started before either finished', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    answerGithub();
    const starts = await Promise.all(
      [1, 2].map(() =>
        post(
          '/link-social',
          { provider: 'github', callbackURL: 'http://localhost:3001/account/accounts' },
          god.cookie,
        ),
      ),
    );
    expect(starts.map((r) => r.status)).toEqual([200, 200]);

    const callbacks: Response[] = [];
    for (const [index, start] of starts.entries()) {
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get(
        'state',
      );
      callbacks.push(
        await app.handle(
          new Request(
            `http://localhost/api/auth/callback/github?code=code-${index + 1}&state=${state}`,
            {
              headers: { cookie: `${god.cookie}; ${cookiesOf(start)}` },
            },
          ),
        ),
      );
    }

    expect(callbacks[0]!.headers.get('location')).not.toContain('error=');
    expect(callbacks[1]!.status).toBe(409);
    expect(await callbacks[1]!.json()).toMatchObject({ code: 'GITHUB_ALREADY_LINKED' });
    expect((await rowsOf(god.userId)).filter((r) => r.providerId === 'github')).toHaveLength(1);
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

  // The browser of the person signing in, as the round trip makes it.
  async function signInWithGithub() {
    answerGithub();
    const start = await post('/sign-in/social', {
      provider: 'github',
      scopes: ['user:email'],
      callbackURL: 'http://localhost:3001/',
      errorCallbackURL: 'http://localhost:3001/login',
    });
    expect(start.status).toBe(200);
    const authorize = new URL(((await start.json()) as { url: string }).url);
    const callback = await app.handle(
      new Request(
        `http://localhost/api/auth/callback/github?code=code-1&state=${authorize.searchParams.get('state')}`,
        { headers: { cookie: cookiesOf(start) } },
      ),
    );
    return { authorize, callback };
  }

  it('signs a new person in with the primary verified address', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    emails = [
      { email: 'other@github.example', primary: false, verified: true },
      { email: 'octo@github.example', primary: true, verified: true },
    ];

    const { authorize, callback } = await signInWithGithub();

    expect(authorize.searchParams.get('scope')).toBe('read:user user:email');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('http://localhost:3001/');
    expect(cookiesOf(callback)).toContain('session_token');
    const [row] = await db.select().from(account).where(eq(account.providerId, 'github'));
    expect(row).toMatchObject({ accountId: '4242', accessToken: null });
  });

  it('refuses a sign-in when GitHub reports no verified primary address', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    emails = [{ email: 'octo@github.example', primary: true, verified: false }];

    const { callback } = await signInWithGithub();

    expect(callback.headers.get('location')).toContain('error=');
    expect(await db.select().from(account).where(eq(account.providerId, 'github'))).toHaveLength(0);
  });

  // Anyone could have registered the address with a password before its owner arrived,
  // so a GitHub address does not take over an unconfirmed account.
  it('does not sign into an unconfirmed account that has the same address', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie);
    const member = await signUpTestUser({ email: 'octo@github.example' });

    const { callback } = await signInWithGithub();

    expect(callback.headers.get('location')).toContain('error=');
    expect(cookiesOf(callback)).not.toContain('session_token');
    expect((await rowsOf(member.userId)).map((r) => r.providerId)).toEqual(['credential']);
  });

  it('refuses to sign in while GitHub is turned off', async () => {
    const god = await signUpTestUser({ name: 'Root' });
    await configureGithub(god.cookie, false);

    const res = await post('/sign-in/social', {
      provider: 'github',
      callbackURL: 'http://localhost:3001/',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_DISABLED' });
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
