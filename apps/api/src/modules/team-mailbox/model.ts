import { t } from 'elysia';

const auth = t.UnionEnum(['password', 'microsoft365']);

// The team mailbox as the settings UI reads it. The secret is never returned: `hasSecret`
// and the Microsoft 365 ids are the redacted mirror.
export const TeamMailboxDto = t.Object({
  host: t.String(),
  port: t.Number(),
  secure: t.Boolean(),
  auth,
  username: t.String(),
  tenantId: t.Nullable(t.String()),
  clientId: t.Nullable(t.String()),
  hasSecret: t.Boolean(),
  agentId: t.Number(),
  agentName: t.String(),
  allowedSenders: t.Array(t.String()),
  status: t.UnionEnum(['active', 'paused']),
  lastError: t.Nullable(t.String()),
  lastPolledAt: t.Nullable(t.Date()),
});

const connection = {
  host: t.String({ minLength: 1, maxLength: 255 }),
  port: t.Integer({ minimum: 1, maximum: 65535 }),
  secure: t.Boolean(),
  auth,
  username: t.String({ minLength: 1, maxLength: 255 }),
  agentId: t.Number(),
  // Full addresses or `@domain`. An empty list triages no email.
  allowedSenders: t.Array(t.String({ minLength: 1, maxLength: 255 }), { maxItems: 200 }),
};

const secrets = {
  // auth 'password': the mailbox password.
  password: t.Optional(t.String({ maxLength: 1000 })),
  // auth 'microsoft365': the app registration.
  tenantId: t.Optional(t.String({ maxLength: 100 })),
  clientId: t.Optional(t.String({ maxLength: 100 })),
  clientSecret: t.Optional(t.String({ maxLength: 1000 })),
};

export const TeamMailboxCreateBody = t.Object({ ...connection, ...secrets });

// Secrets left out or empty keep the stored value. Sending them is how a paused mailbox is
// reconnected.
export const TeamMailboxUpdateBody = t.Partial(t.Object({ ...connection, ...secrets }));
