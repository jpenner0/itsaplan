# Syncing issues with GitHub

A project that has a linked GitHub repository can sync its issues with that repository in both
directions. Outside contributors report issues on GitHub, the team plans in It's a Plan, and
status, comments and fields stay the same on both sides. Both sides have equal standing.

Only GitHub is supported. The sync uses the team's provider connection with its access token.
It does not use a GitHub App.

## What you need

- A provider connection to GitHub in the team, and the repository linked to the project. See
  [Git webhooks on a private instance](self-hosting.md#git-webhooks-on-a-private-instance) for
  the webhook endpoint the connection uses.
- An access token that can read and write issues in that repository, besides the access the
  connection already needs to manage webhooks. The connection lists only repositories where the
  token holder is an administrator.
  - Fine-grained token: add **Issues: Read and write** to Metadata, Webhooks and Pull requests.
  - Classic token: scope `repo` (or `public_repo` for public repositories only) and
    `admin:repo_hook`.
- The permission to manage repositories in the project settings.
- Optional: a GitHub OAuth app, so members can link their GitHub account and sign in with GitHub. Without it the sync
  works, but GitHub users are not matched to members (see [Linking accounts](#linking-accounts)).

## Linking accounts

The sync matches GitHub users to members through a linked GitHub account. The same OAuth app
also lets people sign in with GitHub. The link is for identity only, and every write to GitHub
uses the team's access token.

### Create the OAuth app (instance administrator)

1. On GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set **Authorization callback URL** to `<API_URL>/api/auth/callback/github`. God mode shows
   the exact value and has a button to copy it. GitHub refuses the link when it does not match.
3. Create the app and generate a client secret.
4. In god mode, open the **Auth provider** page, enter the client ID and the client secret in
   the GitHub section, and turn GitHub on. The change applies without a restart.

The app asks for the scope `read:user` only.

### Link your account (member)

Open your profile's **Accounts** page and connect GitHub. The row appears only while an
administrator has set GitHub up. It shows the numeric GitHub user ID. A member links one GitHub
account. **Disconnect** removes the link.

A GitHub user without a linked account still syncs. Their comments appear under a bot user,
with their GitHub login and a link to the original comment.

## Turning the sync on

1. In the project's settings, open the git section and connect the GitHub repository through a
   provider connection.
2. Turn on **Issues sync** for the repository. The webhook is reinstalled with the `issues` and
   `issue_comment` events, and all open issues of the repository are imported once with their
   comments. Closed issues are not imported.
3. **New issues to GitHub** is on by default. While it is on, an issue created in the project
   is also created on GitHub. Turn it off for a public repository when the team plans issues
   that should not become public.

A repository can sync with one project only. Turning the sync on for a repository that another
project syncs fails with a conflict.

Existing issues in It's a Plan are not sent to GitHub. Open an issue, use **Add** in the
Development panel and choose **Publish to GitHub** to create its GitHub issue. The command
appears for an issue that has no GitHub issue yet, in a project that syncs its issues. Comments
written before the publish stay on It's a Plan.

## What is synced

| Field       | Rule                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------ |
| Title       | Both directions, as a whole field.                                                         |
| Description | Both directions, Markdown, as a whole field.                                               |
| Status      | Both directions, see [Status](#status).                                                    |
| Labels      | Both directions, matched by name.                                                          |
| Assignee    | Both directions, see [Assignee](#assignee).                                                |
| Comments    | Both directions, including edits and deletes.                                              |

Not synced: priority, issue type, custom fields, dates, estimate, cycle, GitHub milestones,
GitHub issue types and GitHub Projects.

When both sides change the same field, the later change wins. The sync decides per field. Title
and description are replaced as a whole and not merged.

### Status

| It's a Plan column    | GitHub               |
| --------------------- | -------------------- |
| `completed` column    | closed as completed  |
| `canceled` column     | closed as not planned |
| any other column      | open                 |

A move between open columns is not sent to GitHub. In the other direction:

- A GitHub issue closed as completed moves to the first `completed` column.
- A GitHub issue closed as not planned moves to the first `canceled` column.
- A reopened GitHub issue moves to the first `unstarted` column.
- An open GitHub issue in an open column stays where it is.

A move that cannot be made, for example into a column with a full WIP limit, is tried again on
the next sync.

### Labels

Labels are matched by name, ignoring case. A label that is missing on the other side is created
there with its colour. A label deleted on one side is only removed from the issue on the other
side. The label itself stays.

### Assignee

- From GitHub: the first GitHub assignee who linked an account and is a member of the project.
  Without such an assignee the issue has none.
- To GitHub: the assignee is added when their GitHub account is linked. Other GitHub assignees
  stay.

### Comments

- To GitHub, a comment is posted with the header `**Name** (@login, via It's a Plan):`. The
  login is left out when the author has no linked account. Replies become flat comments. When
  someone edits such a comment on GitHub, the header is not copied into the It's a Plan text.
- From GitHub, a comment appears under the linked member. Otherwise it appears under a bot user
  of the connection, shown as `@login on GitHub` with a link to the original.
- A comment that came from GitHub is not sent back.
- Edits and deletes are synced. A comment written on GitHub cannot start an agent run with an
  `@` mention.

### Images and the footer

- An image uploaded to It's a Plan is sent as a link: `📎 image.png (view in It's a Plan)`.
  The link opens the image without a sign-in, so anyone who can read the GitHub issue can open
  the image. Keep this in mind for public repositories.
- Image URLs that point to GitHub are kept as they are and are not downloaded.
- The GitHub issue body ends with the line `Tracked in It's a Plan: [ABC-123](link)`. The sync
  removes this line when it reads the body back. The It's a Plan issue shows the GitHub issue in
  its Development panel, with number, link and an open or closed badge.

## Deleting and unlinking

| What happens                                       | Result                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| An issue is deleted in It's a Plan                 | The GitHub issue is closed as not planned. The link is removed. |
| A comment is deleted in It's a Plan                | The GitHub comment is deleted.                                |
| A GitHub issue is deleted or moved to another repository | The issue moves to the first `canceled` column. The link is removed. |
| A GitHub comment is deleted                        | The comment is deleted in It's a Plan.                        |
| **Issues sync** is turned off, or the repository is disconnected | All issues and comments stay on both sides. Only the links are deleted. |

Turning **Issues sync** on again imports all open issues again. Issues that were synced before
are not matched with the new import, so they exist twice.

## Sync without a public URL

GitHub delivers webhooks only to a public address. An instance without one (see
[Git webhooks on a private instance](self-hosting.md#git-webhooks-on-a-private-instance)) still
syncs: the API asks GitHub for the issues and comments that changed since the last run every 5
minutes. Changes from It's a Plan are sent at once, or at the latest in the next run.

The run cannot see what GitHub does not list. These changes reach It's a Plan only through a
webhook:

- a deleted GitHub issue;
- a GitHub issue moved to another repository;
- a deleted GitHub comment.

An instance without a webhook keeps these issues and comments until someone removes them by
hand.

`ISSUE_SYNC_INTERVAL_MS` changes the interval. See `.env.example` and
[the developer notes](dev/github-issue-sync.md).

## Agent triggers

An agent schedule can start on GitHub events. Add the schedule in the project's agent settings and
choose a trigger type:

- **When a new GitHub issue arrives**: a run for each issue that is created on GitHub after the first
  import. The first import and issues created in It's a Plan start none.
- **When a pull request is opened**: a run when a pull request is opened (not as a draft) or marked ready
  for review, and it references a synced issue by `#123`, `owner/repo#123`, the issue URL, a
  closing word or the issue key. There is one run per pull request and project.

Each run costs model usage. In a public repository, anyone can open an issue or a pull request, so
give these agents only the tools they need. After an outage of the sync, many new issues can start
many runs at once. Details are in [the developer notes](dev/github-issue-sync.md).

## Limits

- A repository that is renamed on GitHub is followed on the next push from It's a Plan.
  Changes from GitHub for the new name arrive again after that.
- An `@handle` in a description that was imported from GitHub notifies the member it names.
- Comments written before an issue was published are not sent.
- A change that GitHub keeps refusing is retried for about 15 hours, then dropped. The log
  names it.
