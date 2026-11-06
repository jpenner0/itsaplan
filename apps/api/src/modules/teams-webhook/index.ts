import { Elysia, t } from 'elysia';
import { authContext } from '#shared/auth-context';
import { requireUser } from '#shared/access';
import { errors } from '#shared/responses';
import { noContent } from '#shared/http';
import { TeamsWebhookBody, TeamsWebhookResponse } from './model';
import { deleteTeamsWebhook, getTeamsWebhook, saveTeamsWebhook } from './service';

// The session user's own Teams webhook, instance-wide like the Telegram link.
// Self-scoped: a user only reads or changes their own. The URL is never returned.
export const teamsWebhookRoutes = new Elysia({
  name: 'teams-webhook',
  detail: { tags: ['Microsoft Teams'] },
})
  .use(authContext)

  .get('/teams-webhook', ({ user }) => getTeamsWebhook(requireUser(user).id), {
    response: { 200: TeamsWebhookResponse, ...errors(401) },
    detail: { summary: 'Get the Teams webhook connection' },
  })

  .put('/teams-webhook', ({ user, body }) => saveTeamsWebhook(requireUser(user).id, body.url), {
    body: TeamsWebhookBody,
    response: { 200: TeamsWebhookResponse, ...errors(400, 401) },
    detail: {
      summary: 'Connect a Teams Workflows webhook',
      description:
        'Stores the URL encrypted after Teams accepts a test card. Only Workflows webhook hosts are accepted.',
    },
  })

  .delete(
    '/teams-webhook',
    async ({ user }) => {
      await deleteTeamsWebhook(requireUser(user).id);
      return noContent();
    },
    {
      response: { 204: t.Void(), ...errors(401) },
      detail: { summary: 'Disconnect the Teams webhook' },
    },
  );
