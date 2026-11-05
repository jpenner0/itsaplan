# GitHub issue sync

Two-way sync between the issues of a project and the issues of one GitHub repository. The setup
for users is in `docs/github-issue-sync.md`. This page describes how it works.

The sync reads and writes through the team's `git_provider_connection` token. All names in the
data model are provider-neutral. The client in `apps/api/src/modules/git/issues-provider.ts`
supports GitHub only and throws `Issue sync is not supported for <provider>` for any other
provider.

## Where the code lives

| File                                              | What it holds                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `modules/git/issues-provider.ts`                  | REST client: issues, comments, labels, users                         |
| `modules/git/issues-normalize.ts`                 | mappers shared by REST responses and webhook payloads                |
| `modules/git/webhook.ts`                          | verifies a delivery and hands issue events to the inbox              |
| `modules/issue-sync/service.ts`                   | toggle, locking, sync slots, the reconcile                           |
| `modules/issue-sync/inbound.ts`                   | provider → It's a Plan                                               |
| `modules/issue-sync/inbox.ts`                     | stores and applies webhook deliveries                                |
| `modules/issue-sync/outbound.ts`                  | It's a Plan → provider, the outbox, publishing                       |
| `modules/issue-sync/queue.ts`                     | retry schedule shared by the inbox and the outbox                    |
| `modules/issue-sync/normalize.ts`                 | synced fields, hashes, footer and header handling                    |
| `modules/issue-sync/context.ts`                   | the sync flag (`runAsIssueSync`, `isIssueSyncWrite`)                 |
| `apps/api/src/background.ts`                      | the `issue-sync` loop                                                |

Paths are under `apps/api/src/`.

## Data model

Migrations `0176` to `0179`.

| Table or column                              | Purpose                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `git_managed_repository.issues_sync_enabled` | The "Issues sync" toggle of the repository ↔ project link.               |
| `git_managed_repository.new_issues_to_provider` | The project toggle "New issues to GitHub". Default on.                |
| `git_managed_repository.issues_watermark`    | Provider `updated_at` of the newest issue the reconcile has read. `NULL` means the first import is not finished. |
| `git_managed_repository_issues_sync_uq`      | Partial unique index on `(connection_id, external_id)` where sync is on: one project per repository per connection. |
| `git_provider_connection.bot_user_id`        | Author of comments whose provider author has no linked account.          |
| `issue_sync_link`                            | One row per synced issue.                                                |
| `issue_comment_sync_link`                    | One row per synced comment.                                              |
| `issue_sync_outbox`                          | Changes of It's a Plan that are not sent yet. `0177`, `0178`.            |
| `issue_sync_inbox`                           | Webhook deliveries that are not applied yet. `0179`.                     |

### Links

`issue_sync_link` has a unique `issue_id`, so the link belongs to the issue and stays when the
issue moves to another project of the team. It stores `managed_repository_id`, the provider's
`external_id`, `external_number` and `external_url`, `external_updated_at`, `synced_hash` and
`field_hashes`. `(managed_repository_id, external_number)` is unique. Webhooks and REST calls
address an issue by its number.

`issue_comment_sync_link` points to the comment's `issue_activity` row and to the issue link. It
stores the provider's comment id and URL, `external_author_login` for comments that came from the
provider, and the same hash and time columns as the issue link.

Both link tables are removed by `ON DELETE cascade` when the issue, the comment, the issue link
or the repository goes. Unlinking is therefore a delete of rows and never touches issues or
comments. The schema does not check that the issue and the repository belong to the same team.
The sync takes the repository only from the issue's own team.

### Bot user

The bot user is a `user` row with a generated email and no `team_member`, `project_member`,
`ai_agent` or `account` rows. It cannot sign in, has no access and does not count as a seat. It
is created with the first comment that needs it. The foreign key is `ON DELETE set null`, and the
sync creates a new bot user when the old one was deleted.

### Triggers

- `issue_sync_link` has `rev_issue_child('issue_id', 'detail')` on insert and delete, so the issue
  detail updates when an issue gets or loses its link. Updates are left out because every sync
  rewrites the hashes. See `docs/dev/revision-engine.md`.
- The outbox is filled by triggers, not by application code. Issues are deleted and changed on
  many paths (single, bulk, column delete, label delete, project move and delete, team delete),
  and the link rows are gone by cascade once the issue is. A trigger sees every path.
  - `AFTER UPDATE` on `issue` (title, description, column, assignee) and `AFTER INSERT OR
    DELETE` on `issue_label` queue an `issue` row for an issue that has a link.
  - `AFTER INSERT OR UPDATE OF body` on comment rows of `issue_activity` queues a `comment` row.
  - `BEFORE DELETE` on `issue_sync_link`, `issue_comment_sync_link` and
    `git_managed_repository` queues a `close_issue` or `delete_comment` row. It copies the
    connection id, the repository name and provider id, and the external id, because the rows it
    needs are gone afterwards. A deferred constraint trigger drops such a row at commit when the
    issue or comment still exists, which means it was an unlink.
  - The outbox has no foreign keys, so a row outlives its issue and a team delete cannot fail
    on it.

## Hashes, echo protection and conflicts

`normalize.ts` defines `SyncFields` (title, description, status, labels, assignee) and hashes
them. A link stores two hashes of the last synced state:

- `synced_hash` covers all fields. An incoming change that produces this hash is the echo of the
  sync's own write and is ignored.
- `field_hashes` has one hash per field. It tells which side changed a field since the last sync.

The rule is last write wins per field:

1. Only one side changed the field (its hash differs from `field_hashes`): that side wins.
2. Both sides changed it: the later change wins. The local time is the newest `issue_activity`
   row of the field. The provider time is the issue's `updated_at`. There is no timestamp column
   per field, because the local times already exist and the provider has one time per issue.
3. A delivery older than `external_updated_at` is ignored.

A status move that cannot be made (no target column, a full WIP column) keeps the old field hash,
so a later run tries it again.

The sync flag is the second guard. Every inbound write runs inside `runAsIssueSync`, and the
outbound hooks skip a write when `isIssueSyncWrite()` is true. Field writes use the activity
actor `{ system: 'GitHub' }`. A trigger row queued by an inbound write finds nothing to send,
because the push sends the current state and compares it with `field_hashes`.

## Incoming: provider → It's a Plan

### Webhook

The existing route `POST /webhooks/git/:id` handles `issues` and `issue_comment` events next to
the pull request and CI events. When sync is turned on, the repository's webhook is reinstalled
so it subscribes to both events. Issue events are processed even when the project's pull request
integration is off. The repository's own sync switch decides.

The route stores a delivery in `issue_sync_inbox` and answers 200 at once. It does not apply the
delivery, because GitHub gives up after a few seconds and never sends a failed delivery again,
while applying may wait for a busy repository. Deleted and transferred issues and deleted
comments exist only in webhooks, so a lost delivery would lose them for good.

An inbox row stores the repository, the delivery id (unique per repository), the external issue
number, the parsed event as `jsonb`, `attempts`, `last_error` and `next_attempt_at`. `NULL` in
`next_attempt_at` means the sync gave up. The row and the claim of the delivery id
(`claimGitDelivery`) are written in one transaction. A redelivery is answered `duplicate`, also
while the first delivery waits.

Storing a delivery starts a run for its repository, coalesced per repository. The run takes the
repository lock, waits for it without a connection, and applies the due rows in id order. An
applied row is deleted. A failed row is retried with the schedule below and holds back later rows
for the same external issue, so a comment never runs before its issue. A row that exhausted its
attempts stays with its `last_error` and holds back nothing. Turning the sync off deletes the
repository's rows.

### Reconcile

The reconcile reads what a webhook may have missed, and it is the only way in on an instance
without a public URL. It is a loop of the API process, not of the worker:
`startLoop('issue-sync', …)` in `apps/api/src/background.ts`, every `ISSUE_SYNC_INTERVAL_MS`
(default 300000, 5 minutes). Each run does three things in this order:

1. `processIssueSyncInbox()` applies the deliveries that met a busy repository or wait for a retry.
2. `reconcileIssueSync()` reads `GET /issues?since=<watermark>&state=all` and the comments since the
   watermark, for every repository with sync on, and applies them.
3. `processIssueSyncOutbox()` pushes what is left in the outbox (at most 200 rows).

The loop lives in the API for two reasons. The worker must not import `apps/api`, and the sync
writes through the existing issue services, which carry the permissions, activity entries,
WIP checks, mentions and revision triggers. Those services are in the API. Writing from the
worker would copy them. This differs from the ticket, which put the reconcile in the worker.

Rules of the reconcile:

- A repository with no watermark has not finished its first import. The run reads all open issues
  and finishes the import. This is also how a failed first import recovers.
- An unknown open issue is imported. An unknown closed issue is skipped. A known issue is
  updated.
- Comments are listed after issues. The watermark is the newest issue `updated_at`, and a
  comment's time never moves it, so an issue change between the two reads is read again.
- The run cannot see deleted issues, transferred issues or deleted comments. The REST list does
  not return them.
- One item that a service refuses, such as an issue for a full column, is logged and skipped.
  It does not block the repository.

### Mapping

- Status: closed as completed moves the issue to the first `completed` column, closed as not
  planned to the first `canceled` column, and an open issue that is closed locally to the first
  `unstarted` column. An open issue in an open column is not moved.
- Labels: by name, ignoring case. A missing label is created with the GitHub colour. A colour is
  accepted as six hex digits only.
- Assignee: the first GitHub assignee whose linked account is a **project** member, otherwise
  none. `updateIssue` refuses an assignee outside the project, so membership is checked against
  the project and not the team.
- Comments: written under the linked member, otherwise under the bot user with the GitHub login
  as `actorName`. Edits of such a comment use `updateComment` with `mentions: false`, so an
  outside author cannot queue an agent run by adding `@agent`.
- The footer `Tracked in It's a Plan: [KEY-n](url)` is stripped from the body
  (`stripFooter`). The comment header is stripped from an edited comment (`stripCommentHeader`).
- The issue gets an `issue_development_link` with `kind: 'issue'`.
- A GitHub issue that is deleted or transferred moves to the first `canceled` column. Its sync
  link and development link are removed.

## Outgoing: It's a Plan → provider

### Publishing

- A new issue in a project with sync on and `new_issues_to_provider` on is created on GitHub.
  Only the create route `POST /projects/:projectKey/issues` publishes. Imports and the inbound
  sync do not.
- `POST /issues/:issueId/publish` links one existing issue. It needs the permission to edit the
  issue. It answers 201 with the external number and URL, 409 when the issue is linked already
  or the project does not sync, and the provider error (400 or 502) when GitHub refuses.
- Creating the GitHub issue stores the link before anything else can fail. A failed update
  after that queues an `issue` row, so the retry updates the issue and never creates a second
  one.

### Pushing a change

A write that changes a synced field queues a row through the triggers. The write then starts
`pushIssueSync` in the background, without awaiting it, so a slow or failing GitHub never blocks
or rolls back the local change. The push:

1. takes the repository lock without waiting. When another sync holds it, the row stays and the
   next background run sends it, without counting an attempt;
2. reads the GitHub issue;
3. sends only the fields that differ from `field_hashes`, and skips a field that GitHub changed
   later than the local change, which is left for the inbound side;
4. stores the hashes of the sent fields as GitHub returned them and recomputes `synced_hash`, so
   the webhook echo is ignored while a not yet applied GitHub change is not swallowed.
   `external_updated_at` is not touched, for the same reason.

All pushes of a replica run in one queue, so they use at most one of the two sync slots.

Field rules: the body is the description with the footer line. Status maps `completed` to closed
as completed, `canceled` to closed as not planned and every other column to open. Labels go by
name and a missing GitHub label is created in the local colour. The assignee is added when their
account is linked, and other GitHub assignees stay. An image
`![name](/media/attachments/…)` becomes `[📎 name (view in It's a Plan)](APP_URL/media/attachments/…)`.
That URL is the public attachment route, so it needs no sign-in.

Comments are pushed only when their issue is linked. The header is
`**Name** (@login, via It's a Plan):`, with the login read from `GET /user/{id}` and left out
without a linked account. Replies are posted flat. A comment that came from GitHub is sent back
without a header.

### Tombstones

A delete removes the link rows, so a `close_issue` or `delete_comment` row carries what the push
needs: connection, repository name and provider id, external id. Deleting an issue closes the
GitHub issue as not planned. Deleting a comment deletes the GitHub comment. Unlinking (sync off,
repository disconnected, GitHub issue deleted or transferred) closes nothing, because the
deferred trigger drops those rows.

Before it sends, `pushTombstone` reads the repository by its provider id and uses its current
name, so a close after a rename still arrives. If GitHub still redirects under the current name,
the issue was transferred and the row is dropped. Reading by id needs admin rights. Without
them, or for a deleted repository, the stored name is used. A row whose connection is gone has
no token and is dropped.

### Rename and transfer

GitHub answers a transferred issue and a renamed repository with the same redirect. On a
redirect, the push reads the repository by its id. A changed name updates
`git_managed_repository.full_name` and `web_url`, and the push is retried. An unchanged name
means a transfer: the issue is unlinked and moved to `canceled`.

### Retry

The inbox and the outbox share `queue.ts`. After a failure the delay doubles from 1 minute up to
1 hour. After 20 attempts, about 15 hours, an outbox row is dropped with a log line, and an inbox
row gets `next_attempt_at = NULL` and keeps its `last_error`. A new change raises the outbox
row's `version`, and a push removes the row only while the version is the one it sent.

## Locking

One sync of a repository runs at a time across replicas. `tryRepositoryLock` in `service.ts`
runs inside a transaction and calls `pg_try_advisory_xact_lock(8251, repositoryId)`. When the
lock is held, the transaction ends at once and the caller retries after 200 ms. A waiting caller
holds no database connection.

`withRepositoryLock(repositoryId, wait, fn)`:

- With `wait = false`, the reconcile, the inbox job and the outbox skip a busy repository.
- With `wait = true`, a webhook run or the toggle retries until `ISSUE_SYNC_LOCK_WAIT_MS`
  (default 60000) has passed, then gives up with 503. The toggle route answers it. A webhook
  has answered 200 by then and its delivery stays in the inbox for the background run.

Each replica runs at most two syncs at once (`MAX_RUNNING_SYNCS`). A running sync holds one
connection for its lock and takes more for its writes. A cap below the pool size (10 for
postgres.js) leaves a connection for some lock holder at all times. A caller without a slot
waits in memory and holds no connection.

Turning the sync on is the other path that needs the lock. It first rejects a repository that
another connection to the same provider host already syncs. The partial unique index covers the
same connection only. Then it reinstalls the webhook and imports every open issue with its
comments under the lock.

## Environment variables

| Variable                  | Default | Meaning                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `ISSUE_SYNC_INTERVAL_MS`  | 300000  | Interval of the `issue-sync` loop.                                   |
| `ISSUE_SYNC_LOCK_WAIT_MS` | 60000   | How long a webhook run or the toggle waits for a busy repository.    |

Both are optional and are listed in `.env.example` only, like `AUTO_ARCHIVE_INTERVAL_MS` and
`SHARE_EXPIRY_INTERVAL_MS`. Compose files and the Helm chart do not list them. Set them with the
process environment of the api.

## Security notes

- Provider text is untrusted. URLs are accepted for `http` and `https` only, and a label colour
  for six hex digits only. External URLs and logins are rendered as text or as a link after a
  scheme check.
- The webhook signature check is unchanged. Provider calls go through `@repo/net`.
- An outside commenter cannot start an agent run: comments under the bot user skip mentions.
- An `@handle` in the description of an imported or edited GitHub issue notifies the member it
  names, through `notifyTextMentions`. It queues no agent run, because only comments reach
  agents.

## Known limits

- The reconcile cannot see deleted issues, transferred issues or deleted comments. Only the
  webhook reports them. Without a webhook they stay.
- A delivery that the sync gave up on cannot be redelivered from GitHub, because its id is
  claimed. The next reconcile applies the current state of the issue, so only a delete or a
  comment delete stays lost.
- Paths that have no direct push call (column delete, label delete, project move, project and
  team delete) are sent by the next background run, up to 5 minutes later.
- After a project move, the footer names the old issue key until the description is sent again.
  The old key resolves through `issue_key_alias`.
- Comments are pushed only once their issue is linked. Publishing an existing issue does not send
  its earlier comments.
- After a repository rename, comment pushes and edits fail until an issue push of that
  repository reads the new name. Inbound events for the new name are ignored until then, and the
  reconcile's list call gets a redirect.
- Turning the sync off and on again imports without deduplication.
- A user whose only `account` row is GitHub cannot unlink it. See `docs/dev/auth.md`.
- `providerErrorMessage` words every 422 as a webhook error, which is misleading for issue calls.
