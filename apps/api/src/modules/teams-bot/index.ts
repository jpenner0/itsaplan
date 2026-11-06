import { Elysia, t } from 'elysia';
import { authContext } from '#shared/auth-context';
import { requireUser } from '#shared/access';
import { HttpError } from '#shared/lib';
import { errors } from '#shared/responses';
import { noContent } from '#shared/http';
import { readTeamsBotConfig } from '@repo/net/teams-bot';
import { TeamsBotAccountResponse, TeamsBotLinkStartResponse } from './model';
import { getTeamsBotLink, startTeamsBotLink, teamsBotChatUrl, unlinkTeamsBot } from './service';

function requireBot() {
  const config = readTeamsBotConfig();
  if (!config) throw new HttpError(400, 'The Teams bot is not configured on this instance');
  return config;
}

// The session user's own link to the Microsoft Teams bot, self-scoped like the Telegram
// link. The messaging endpoint the Bot Framework calls is in messages.ts.
export const teamsBotRoutes = new Elysia({
  name: 'teams-bot',
  detail: { tags: ['Microsoft Teams'] },
})
  .use(authContext)

  .get(
    '/teams-bot/account',
    async ({ user }) => {
      const config = readTeamsBotConfig();
      return {
        available: config !== null,
        chatUrl: config ? teamsBotChatUrl(config) : null,
        link: await getTeamsBotLink(requireUser(user).id),
      };
    },
    {
      response: { 200: TeamsBotAccountResponse, ...errors(401) },
      detail: { summary: 'Get the linked Teams bot account' },
    },
  )

  .post(
    '/teams-bot/account/link',
    async ({ user }) => {
      const config = requireBot();
      const { code, expiresAt } = await startTeamsBotLink(requireUser(user).id);
      return { code, chatUrl: teamsBotChatUrl(config), expiresAt };
    },
    {
      response: { 200: TeamsBotLinkStartResponse, ...errors(400, 401) },
      detail: {
        summary: 'Start linking a Teams account',
        description:
          'Mints a one-time code. The user sends `link <code>` to the bot in a personal chat.',
      },
    },
  )

  .delete(
    '/teams-bot/account',
    async ({ user }) => {
      await unlinkTeamsBot(requireUser(user).id);
      return noContent();
    },
    {
      response: { 204: t.Void(), ...errors(401) },
      detail: { summary: 'Unlink the Teams bot account' },
    },
  );
