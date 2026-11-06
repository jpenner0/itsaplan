import { t } from 'elysia';

export const TeamsWebhookResponse = t.Object({
  connected: t.Boolean(),
  host: t.Nullable(t.String()),
  // Set when Teams refused a delivery permanently; the member has to save the URL again.
  broken: t.Boolean(),
  lastError: t.Nullable(t.String()),
});

export const TeamsWebhookBody = t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }) });
