# Email intake

Bug reports and requests often arrive by email. The email intake reads a mailbox you connect and
turns its emails into issues. Nothing is sent back to the sender, and no notification is sent
about new emails.

## Connect a mailbox

Open **Account → Mailboxes** and choose **Connect mailbox**. Only you see the mailbox and its
credentials. A shared address such as `support@` is connected by the person who looks after it.

| Field         | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| IMAP host     | for example `imap.example.com`                                  |
| Port          | 993 with TLS, 143 with STARTTLS                                 |
| Sign-in       | a password, or Microsoft 365 (see below)                        |

The host must be reachable from the server. A host on a private network is refused unless the
administrator lists it in `SSRF_ALLOWED_HOSTS`.

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

## Choose folders

A mailbox has one or more **folders**. Add each folder you want read and choose a **team** and an
**agent** of that team. The team pays for the AI, and only projects of that team are suggested.
Someone who triages for two teams adds two folders.

Only the chosen folder is read, and **everything in it is sent to the AI provider of the agent**.
Put the emails meant for the intake there by hand or with a mail rule in your mail program.

## What happens to the mailbox

- The server checks each folder every 5 minutes.
- It does not move, flag or mark any email as read.
- Emails that were in the folder before you added it are ignored.
- Attachments within the upload limits of the instance are kept; a larger file is only listed.

## When sign-in fails

After repeated sign-in failures (a changed password, an expired token) the folder is paused. The
page shows the error. Choose **Reconnect**, enter the new credentials and save: the folder starts
again and reads the emails that arrived meanwhile.

## Mail inbox

Each new email is checked by the agent of its folder. The agent sorts out spam, newsletters and
automatic replies, classifies the email (bug, feature, question, no ticket), writes a draft issue
and suggests a project of the folder's team in which you may create issues. It looks for an open
issue that reports the same.

The agent only reads. It cannot create or change anything, and it ignores instructions inside an
email. Teams adjust the rules in the agent's instructions.

Open **Mail inbox** in the sidebar. The number is the count of open drafts. Only you see them. For
each draft you can change the project, title, description, labels and priority, then:

- **Accept** creates the issue. You are its creator, and it is visible to everyone who may see the
  project. Attachments within the upload limits become attachments of the issue.
- **Add as comment to ABC-123** attaches the email to the possible duplicate.
- **Reject** removes the draft from the list. The email is deleted after 30 days.
- **Check again** repeats the check, for example after it failed.

Spam, newsletters and emails that need no issue are in the collapsed **Sorted out** section. They
are not deleted and you can still accept them.

After you accept a draft, the original email and its attachments are deleted from It's a Plan. Only
the sender, the `Message-ID` and the issue are kept, to match replies.

## Replies

When the sender answers an email that became an issue, the answer is added to that issue as a
comment at once, without a check by the agent. The comment is written by you, the mailbox owner,
and starts with "via email from Name <address>". Quoted earlier messages and signatures are cut
off. Attachments within the upload limits are added to the issue. A closed issue gets the comment
and stays closed.

An answer is matched through the email headers (`In-Reply-To` and `References`), not by the
subject. If you can no longer comment on the issue, or it was deleted, the email goes to the Mail
inbox like a new one.
