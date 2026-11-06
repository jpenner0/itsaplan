import { t } from 'elysia';

const auth = t.UnionEnum(['password', 'microsoft365']);

export const MailboxFolderDto = t.Object({
  id: t.Number(),
  name: t.String(),
  teamId: t.Number(),
  teamName: t.String(),
  agentId: t.Number(),
  agentName: t.String(),
  status: t.UnionEnum(['active', 'paused']),
  lastError: t.Nullable(t.String()),
  lastPolledAt: t.Nullable(t.Date()),
});

// The mailbox as the settings UI reads it. The secret is never returned: `hasSecret` and
// the Microsoft 365 ids are the redacted mirror.
export const MailboxDto = t.Object({
  id: t.Number(),
  label: t.String(),
  host: t.String(),
  port: t.Number(),
  secure: t.Boolean(),
  auth,
  username: t.String(),
  tenantId: t.Nullable(t.String()),
  clientId: t.Nullable(t.String()),
  hasSecret: t.Boolean(),
  folders: t.Array(MailboxFolderDto),
});

export const MailboxList = t.Array(MailboxDto);

const connection = {
  label: t.String({ minLength: 1, maxLength: 100 }),
  host: t.String({ minLength: 1, maxLength: 255 }),
  port: t.Integer({ minimum: 1, maximum: 65535 }),
  secure: t.Boolean(),
  auth,
  username: t.String({ minLength: 1, maxLength: 255 }),
};

const secrets = {
  // auth 'password': the mailbox password.
  password: t.Optional(t.String({ maxLength: 1000 })),
  // auth 'microsoft365': the app registration.
  tenantId: t.Optional(t.String({ maxLength: 100 })),
  clientId: t.Optional(t.String({ maxLength: 100 })),
  clientSecret: t.Optional(t.String({ maxLength: 1000 })),
};

export const MailboxCreateBody = t.Object({ ...connection, ...secrets });

// Secrets left out or empty keep the stored value, as in the team notification settings.
// Sending them is how a paused mailbox is reconnected.
export const MailboxUpdateBody = t.Partial(t.Object({ ...connection, ...secrets }));

export const FolderBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  teamId: t.Number(),
  agentId: t.Number(),
});

export const MailboxParams = t.Object({ mailboxId: t.Numeric() });
export const FolderParams = t.Object({ mailboxId: t.Numeric(), folderId: t.Numeric() });

// What the folder form offers: only the teams the user belongs to and the internal agents of
// those teams.
export const MailboxOptions = t.Object({
  teams: t.Array(
    t.Object({
      id: t.Number(),
      name: t.String(),
      agents: t.Array(t.Object({ id: t.Number(), name: t.String() })),
    }),
  ),
});
