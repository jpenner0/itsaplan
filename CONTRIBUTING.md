# Contributing to It's a Plan

Thanks for wanting to help. This document covers how to get the project running, what
the code conventions are, and how a change gets merged.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bug**: open an issue with the bug template, or comment on an existing one.
- **Feature**: open an issue with the feature template first. Agreeing on the behaviour
  before the code is written saves a rewrite.
- **Small fixes** (typos, broken links, obvious one-liners) can go straight to a pull
  request without an issue.
- Look for issues labelled `good first issue` if you want a place to start.

## Development setup

[docs/development.md](docs/development.md) covers the requirements, the setup, and the
commands you run from the repository root.

## Project layout

```
apps/api        Elysia (Bun) HTTP API, mounts better-auth at /api/auth/*
apps/web        Next.js App Router, server-side rendered
apps/worker     background jobs: webhooks, notifications, agent runs
apps/bot        Telegram bot, long polling
packages/db     Drizzle client, schema, migrations
packages/auth   better-auth server instance
packages/crypto AES-256-GCM encryption for secrets at rest
packages/mailer SMTP and Resend transport
```

Dependency direction is `api → @repo/auth → @repo/db`. The web app never imports the
packages directly, it talks to the API over HTTP.

Each app, plus `packages/auth` and `packages/db`, has an `AGENTS.md` with the rules that
apply inside it. Read the one for the area you are changing.

Do not add to an `AGENTS.md` to record a fix or a feature. `docs/dev/agents-md.md` says what
belongs there.

## Code conventions

- **KISS and YAGNI.** The simplest thing that works. No abstraction until more than one
  concrete implementation needs it.
- **Follow the existing patterns.** Read the neighbouring code before adding a new file,
  and reuse the shared components and utilities instead of adding parallel ones.
- **All code, comments, and strings are in English.**
- Shared packages are consumed as TypeScript source. Do not add a build step for them.
- Formatting and linting are enforced by a pre-commit hook (lefthook), and again in CI.

### Database changes

Edit the Drizzle schema in `packages/db/src/schema`, then generate and apply:

```bash
bun run db:generate   # writes SQL to packages/db/drizzle
bun run db:migrate
```

Commit the generated SQL. Never edit a migration that has already been merged, add a new
one instead. Changing the better-auth config in `packages/auth` can change its tables:
run `bun run auth:generate` first, then generate the migration.

### Tests

`apps/api` has an integration suite that runs against a real Postgres, not mocks. See
`apps/api/AGENTS.md` for how to write one, and
[docs/development.md](docs/development.md#tests) for how to run the suite and the CI gate.

## Pull requests

1. Branch off `main`: `git checkout -b feat/short-description`.
2. Keep the change focused. One concern per pull request.
3. Title follows [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(web): add issue templates`, `fix(api): reject empty label names`,
   `improvement(web): ...`, `docs: ...`, `refactor: ...`, `chore: ...`.
   The title picks the released version, so choose the type by what the change
   gives the user:

   - `feat` — a capability that did not exist. Bumps the minor.
   - `improvement` — a visible change to something that already exists: a
     redesign, a reworked layout, a better interaction. Bumps the patch.
   - `fix` — behaviour that was wrong is now right. Bumps the patch.
   - `perf`, `refactor`, `docs`, `build`, `ci`, `test`, `chore`, `revert` — bump
     the patch.

   The full list of accepted types is in `.github/workflows/pr-title.yml`.

4. If you develop with an AI agent, run the project skills from `.agents/skills/` on
   the new code, in this order: `tidy`, `code-review`, `security-audit`.
5. Before pushing, make sure these pass:

   ```bash
   bun run format:check && bun run lint && bun run typecheck
   ```

6. Fill in the pull request template, link the issue (`Closes #123`), and add
   screenshots for UI changes.
7. CI must be green before review.
