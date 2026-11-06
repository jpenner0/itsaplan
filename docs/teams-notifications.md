# Microsoft Teams notifications

Microsoft Teams is a third personal notification channel next to email and Telegram. It delivers
the same events as Telegram: assigned, mentioned, commented and state changed. Delivery uses a
Teams Workflows webhook that you create for a chat or channel of your own.

Only Workflows webhooks that accept an Adaptive Card are supported. The retired Office 365
connector URLs are not.

## For a member

1. In Teams, open the chat or channel that should receive the notifications.
2. Open **Workflows** and create a workflow from the template **Send webhook alerts to a chat**
   or **Send webhook alerts to a channel**.
3. Copy the URL of the workflow. It is a secret: anyone who has it can post to your chat.
4. In It's a Plan, open **Account → Accounts**, paste the URL under Microsoft Teams and save.
   It's a Plan sends a test card, and stores the URL only if Teams accepts it.
5. In a project's notification settings, tick the events you want in the Teams column. The
   column shows only when the team owner has turned Teams on.

The URL applies to all your projects on the instance. It is stored encrypted and is never shown
again; the account page shows only its host. **Disconnect** deletes it. Your Teams toggles stay,
so connecting again restores your earlier choice.

The URL must be `https` and its host must end in `.logic.azure.com` or `.api.powerplatform.com`.

### If the connection breaks

A rate limit (429) or a Teams outage (5xx) is retried. Any other error, such as a deleted
workflow, marks the connection broken. No Teams messages are queued while it is broken, and the
account page shows the error. Create the workflow again if needed, then save the URL again: the
test card runs and clears the broken state.

## For a team owner

In the team's notification providers, the **Microsoft Teams** tab has one switch. It is off by
default. While it is off, members do not see the Teams column for the team's projects, and
queued Teams messages fail permanently. Teams needs no other credentials from the team.

## For an operator

- No environment variable is needed. The webhook URL is encrypted with `APP_ENCRYPTION_KEY`.
- The api and the worker reach `*.logic.azure.com` and `*.api.powerplatform.com` over https.
- Requests go through `@repo/net`, so a host that resolves to a private address is refused.
