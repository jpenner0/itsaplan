# Email intake

Bug reports and requests often arrive by email. The email intake reads a mailbox you connect and
turns its emails into issues. Nothing is sent back to the sender, and no notification is sent
about new emails.

## Connect the team mailbox

A team has one mailbox. A team owner or manager opens the team settings, section **Mailbox**, and
sets it up. Everyone in the team sees the emails it receives, in the **Mail inbox**. A shared
address such as `support@` is a good choice.

| Field           | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| IMAP host       | for example `imap.example.com`                                           |
| Port            | 993 with TLS, 143 with STARTTLS                                          |
| Sign-in         | a password, or Microsoft 365 (see below)                                 |
| Agent           | an internal agent of the team; the team pays for its AI runs             |
| Allowed senders | addresses (`anna@example.com`) or domains (`@example.com`), one per line |

The host must be reachable from the server. A host on a private network is refused unless the
administrator lists it in `SSRF_ALLOWED_HOSTS`.

### Allowed senders

The address of the mailbox is public: anyone can write to it, and every email that is read costs
an AI run. Only emails from an allowed sender are checked by the agent.

- With an empty list no email is checked.
- A domain entry matches that domain only, not its subdomains.
- The sender must also be authenticated. The mail server has to write an `Authentication-Results`
  header that shows `dmarc=pass`, or `spf=pass` or `dkim=pass` for the domain of the sender. This
  stops someone from writing a listed address in the `From` field. Without that header no email is
  allowed.

Emails that are not allowed are not checked. They are in the **Sorted out** section of the Mail
inbox and can still be accepted by hand.

### Microsoft 365

Microsoft 365 no longer accepts a password for IMAP when the mailbox has MFA. Use an app
registration instead:

1. In Microsoft Entra, register an application and create a client secret.
2. Add the API permission **Office 365 Exchange Online → Application permissions →
   IMAP.AccessAsApp** and grant admin consent.
3. Register the application's service principal in Exchange Online
   (`New-ServicePrincipal`) and give it access to the mailbox
   (`Add-MailboxPermission … -AccessRights FullAccess`).
4. In It's a Plan, choose **Microsoft 365 (XOAUTH2)** and enter the tenant ID, the client ID and the
   client secret. The user name is the mailbox address. The host is `outlook.office365.com`,
   port 993.

## What is read

Only the `INBOX` folder is read, and **everything in it from an allowed sender is sent to the AI
provider of the agent**. Put the emails meant for the intake there by hand or with a mail rule in
your mail program.

## What happens to the mailbox

- The server checks the mailbox every 5 minutes.
- It does not move, flag or mark any email as read.
- Emails that were in the inbox before it was connected are ignored.
- Attachments within the upload limits of the instance are kept; a larger file is only listed.

## When sign-in fails

After repeated sign-in failures (a changed password, an expired token) the mailbox is paused. The
team settings show the error. Enter the new credentials and save: the mailbox starts again and reads the emails that arrived meanwhile.

## Mail inbox

Each new email from an allowed sender is checked by the agent of the mailbox. The agent sorts out spam, newsletters and
automatic replies, classifies the email (bug, feature, question, no ticket), writes a draft issue
and suggests a project of the team. It looks for an open
issue that reports the same.

The agent only reads. It cannot create or change anything, and it ignores instructions inside an
email. Teams adjust the rules in the agent's instructions.

Open **Mail inbox** in the sidebar. The number is the count of open drafts. Every member of the team sees them and any of them can decide. For
each draft you can change the project, title, description, labels and priority, then:

- **Accept** creates the issue. You are its creator, and you need to be allowed to create issues in the project, and it is visible to everyone who may see the
  project. Attachments within the upload limits become attachments of the issue.
- **Add as comment to ABC-123** attaches the email to the possible duplicate.
- **Reject** removes the draft from the list. The email is deleted after 30 days.
- **Check again** repeats the check, for example after it failed.

Spam, newsletters and emails that need no issue are in the collapsed **Sorted out** section. They
are not deleted and you can still accept them. This includes emails from senders that are not allowed.

After you accept a draft, the original email and its attachments are deleted from It's a Plan. Only
the sender, the `Message-ID` and the issue are kept, to match replies.

## Replies

When the sender answers an email that became an issue, the Mail inbox shows the answer with
**Add as comment** already filled in for that issue and skips the agent. Nothing is posted until a
team member confirms. The comment is written by that member and starts with "via email from Name
<address>". Quoted earlier messages and signatures are cut off. Attachments within the upload
limits are added to the issue. A closed issue gets the comment and stays closed.

An answer is matched through the email headers (`In-Reply-To` and `References`), not by the
subject. If the issue was deleted, the email is checked like a new one.
