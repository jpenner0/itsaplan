import { Elysia, t } from 'elysia';
import { errors } from '#shared/responses';
import { TeamsActivityBody } from './model';
import { handleTeamsActivity } from './service';

// The messaging endpoint of the Microsoft Teams bot, called by the Bot Framework. It has
// no session: the Microsoft-signed bearer token is the authentication. Mounted on the
// root app, like the git webhook, because the planner's session guard would answer 401
// before the token is checked.
export const teamsBotMessageRoutes = new Elysia({
  name: 'teams-bot-messages',
  detail: { tags: ['Microsoft Teams'] },
}).post(
  '/teams-bot/messages',
  async ({ body, headers }) => {
    await handleTeamsActivity(body, headers.authorization);
    return {};
  },
  {
    body: TeamsActivityBody,
    response: { 200: t.Object({}), ...errors(400, 401, 404) },
    detail: {
      summary: 'Teams bot messaging endpoint',
      description:
        'Receives activities from the Bot Framework. Authenticated by the Microsoft-signed bearer token.',
    },
  },
);
