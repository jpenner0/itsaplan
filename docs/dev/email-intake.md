# Email intake

Incoming emails become issues. This document covers the whole intake; the sections are in the
order of the pipeline. The intake does not talk to GitHub: whether an issue goes to GitHub is
decided by the issue sync. It sends no email back to the sender and no notification about new
emails.

## Mailbox and folder

- A `mailbox` belongs to one user (`user_id`). Only that user lists, edits or deletes it
  (`modules/mailboxes`, routes under `/account/mailboxes`). The routes are not MCP tools.
- The sign-in is encrypted like `team_notification_setting`: `ciphertext`, `iv`, `auth_tag`, plus a
  `redacted` jsonb the UI reads. The decrypted shape is `MailboxSecret` in
  `packages/db/src/domains/mailbox.ts`; the worker decrypts it, the api never returns it.
- Two sign-in modes: `password`, and `microsoft365` (XOAUTH2 with an app registration). The token
  request is `microsoftAccessToken` from `@repo/mailer`, the same code SMTP uses. The app
  registration needs the `IMAP.AccessAsApp` permission and access to the mailbox.
- A `mailbox_folder` is one folder that is read, with a team and an internal agent of that team.
  The team pays for the AI. Only teams the user belongs to and their internal agents can be
  chosen (`assertTeamAndAgent`). Only the chosen folder is read, and everything read goes to the
  AI provider, so the user decides which emails land in it.
- The IMAP host goes through `resolveHostForConnect` in `@repo/net` when it is saved and every
  time the worker connects. The worker connects to the address that was checked and keeps the
  host name for TLS. `SSRF_ALLOWED_HOSTS` exempts a private host the operator trusts.
- The api does not test the connection. The worker reports the first failure on the folder.

## Fetching

`apps/worker/src/mail-worker.ts` runs its own loop on `poll-loop.ts`. A tick claims the team
mailboxes that are due (`claimDueMailboxes`): `status = 'active'` and `next_poll_at <= now()`. The
claim pushes `next_poll_at` forward by five minutes, so several replicas never read one mailbox,
and a crashed poll is retried at the next interval.

- Only `INBOX` is read, read-only. No email is moved, flagged or marked as read.
- `uid_validity` and `last_uid` are the watermark. The first poll, and a poll after `UIDVALIDITY`
  changed, set `last_uid` to the highest UID in `INBOX` (`UIDNEXT - 1`) and read nothing, so mail
  that was there before is ignored. After each stored email the watermark moves to its UID.
- At most 50 emails are read per poll.
- Three sign-in failures in a row set `status = 'paused'` with `last_error`. The worker does not
  poll a paused mailbox. Any other error only records `last_error` and is retried at the next
  interval.

### Sender check

`mail-auth.ts` (no database) decides `intake_item.sender_allowed`. It is true only when both hold:

- The sender's address, or its domain, is in `allowed_senders`. A domain entry matches that domain
  only, not its subdomains. An empty list lets nobody in.
- The topmost `Authentication-Results` header shows `dmarc=pass`, or `spf=pass` (`smtp.mailfrom`)
  or `dkim=pass` (`header.d`) for the same domain as `From`. Headers below the topmost one can be
  written by the sender and are ignored. A missing header, a failed check, a pass for another
  domain or more than one `From` header means not allowed.

An email that is not allowed is stored but gets no triage run and is never posted as a comment on
an issue.

## Stored email

`parseMail` (`mail-parse.ts`, no database) reads the raw source. `storeMail` (`mail-store.ts`)
inserts an `intake_item` with the sender, subject, `Message-ID`, `In-Reply-To`, `References`, date
and body. A `Message-ID` already stored for the mailbox is skipped. A mail without one gets a stable
id derived from its source.

- An HTML body is converted to Markdown (`turndown`); scripts and styles are dropped.
- Attachments within the instance storage limits (`getStorageSettings`: size and MIME types) are
  put in the object store under `intake/<mailbox id>/…`; a larger or disallowed file is only listed
  by name and size (`s3_key` null). Inline images under 5 KB are ignored.

## Retention

- Rejected items are deleted with their attachments 30 days after `decided_at`
  (`deleteExpiredRejected`, run on every tick).
- Accepted items lose their body and attachments; the metadata stays so replies can be matched.
- Undecided items are kept.

## Triage

The worker queues the triage when it stores a new item (`queueTriage` in `mail-store.ts`): an
`agent_run` with `trigger = 'mail_triage'` and `intake_item_id`, for the folder's agent. The run needs
a project, so the worker takes the first active project of the folder's team the agent is a member
of. Without one nothing is queued and the item shows "Check again". The api poller executes the run
like any internal run (cost, traces, retries, concurrency limits); `run-poller.ts` sends a
`mail_triage` run to `runMailTriage` in `modules/mail-inbox/triage.ts` instead of `runAgent`.

- **Prompt injection.** The email is untrusted text. `runTriageAgent`
  (`modules/agents/core/runtime/triage.ts`) builds an agent with only `get_issue` and
  `search_issues` (`readTools`). The tools enabled on the agent, its skills, its custom tools and
  its memory are not available in this run, so the agent cannot create or change anything. Its
  only output is a JSON answer, which `applyTriage` validates.
- **Instructions.** The agent's own instructions follow the fixed triage preamble, so a team tunes
  the rules there.
- **Projects.** The preamble lists the projects the agent may suggest: projects of the folder's
  team the agent is a member of and the mailbox owner may create issues in
  (`candidateProjects`). The tools read with the rights of the agent's bot user
  (`getProjectAccess`), so a project it cannot see is not searched.
- **Duplicates.** `search_issues` uses the text search of the issues module (`ilike`) on the open
  issues of one project. There are no embeddings.
- **Answer.** `classification` (`bug`, `feature`, `question`, `no_ticket`, `spam`), project key,
  title, summary, labels, priority and `duplicateOf`. `applyTriage` keeps only labels the project
  has, a priority of `urgent|high|medium|low`, and a duplicate the bot can read. It adds the
  original text below the summary as a quote. An answer that is not JSON fails the run, which is
  retried and then shown as failed. An answer with no valid project stores the classification and
  no draft.
- The assignee, status and custom fields are never set by the AI.

## Mail inbox

`modules/mail-inbox`, routes under `/account/mail-inbox`, all scoped to the mailbox owner. The web
page is `/account/mail-inbox`; its sidebar item appears when the user has a folder and shows the
count of open drafts. The page polls every 30 seconds; the worker writes no revision scope.

- Spam and `no_ticket` items are listed apart ("Sorted out") and are not counted. They can still be
  accepted.
- **Accept** creates the issue as the accepting user, after checking `work_items` `create` in the
  chosen project, which has to be a project of the folder's team. It is created in the project's
  first workflow column. The attachments move to the issue; a file that was only listed, or that
  the project quota refuses, is named in the description. The item keeps its sender,
  `Message-ID` and `issue_id`, and loses its body and attachments.
- **Add as comment** posts the email as a comment of the chosen issue ("via email from …") and
  accepts the item with that issue.
- **Reject** keeps the item for 30 days.
- **Check again** queues a new run when none is pending.
- A decision is claimed with a conditional update, so a double click cannot create two issues.

## Replies

An email that answers an accepted one never goes through triage.

- **Matching.** When the worker stores an email, `findRepliedIssue` (`mail-store.ts`) looks for a
  stored `Message-ID` of an accepted item in `In-Reply-To` or `References`. Accepted items include
  earlier replies and emails added as a comment, so a long thread keeps matching. Only items of
  the same mailbox owner match. A match sets `reply_to_issue_id` on the new item and queues no
  triage run. Subjects are not compared.
- **Posting.** `processMailReplies` (`modules/mail-inbox/replies.ts`) runs in its own api loop
  every 5 seconds. It claims an item with a conditional update, so replicas never post one twice.
  It checks that the issue exists, that the mailbox owner has `work_items` `edit` in its project
  and that the project is writable, then inserts a normal comment as the owner. The comment is a
  normal insert, so the revision triggers refresh the issue (`docs/dev/revision-engine.md`). The
  comment starts with `via email from Name <address>`. `stripReply` cuts quoted lines, the quoted
  earlier message (English and German headers, Outlook headers) and the signature. HTML was
  converted to Markdown when the email was stored.
- **Attachments** within the storage limits become attachments of the issue; a file that was only
  listed is named under the comment.
- **Closed issues** get the comment and stay closed.
- **Fallback.** An issue that was deleted, an owner who can no longer comment, or any error while
  posting clears `reply_to_issue_id` and queues the triage, so the email appears in the Mail inbox
  like a new one. Nothing is retried in a loop.
- After posting, the item is `accepted` with the issue; its body and attachments are deleted.

## Security notes

- The email text comes from outside senders. Triage gives the agent two read tools only (see
  Triage). A reply is posted with no human check, and a comment can start a run of an agent that
  has write tools, so `withoutMentions` breaks every `@handle` in the text of a reply and of an
  email added as a comment.
- A reply is matched by header, not by sender. Anyone who knows the `Message-ID` of an accepted
  email and can send to the mailbox can add a comment to its issue as the mailbox owner. The
  comment names the sender ("via email from …"). Treat the mailbox as an input that senders reach.
- The IMAP host is checked on save and on every connection. `SSRF_ALLOWED_HOSTS` exempts a host.
- A claimed reply that the api cannot post is not retried: it is triaged instead. A crash between
  the claim and the post leaves the item `accepted` without a comment.
