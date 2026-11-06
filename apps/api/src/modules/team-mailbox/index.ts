import { Elysia, t } from 'elysia';
import { guards } from '#shared/guards';
import { noContent } from '#shared/http';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import { teamParams } from '#modules/teams/model';
import { TeamMailboxCreateBody, TeamMailboxDto, TeamMailboxUpdateBody } from './model';
import { createTeamMailbox, deleteTeamMailbox, getTeamMailbox, updateTeamMailbox } from './service';

// The one mailbox of a team for the email intake, set up by the team's owner or a manager. It
// carries credentials, so none of these routes is an MCP tool.
export const teamMailboxRoutes = new Elysia({
  name: 'team-mailbox',
  detail: { tags: ['Mail intake'] },
})
  .use(guards)

  .get('/teams/:teamId/mailbox', ({ params }) => getTeamMailbox(params.teamId), {
    params: teamParams,
    teamManager: true,
    response: { 200: TeamMailboxDto, ...accessErrors, ...errors(404) },
    detail: {
      summary: 'Get the team mailbox',
      description: 'Status and last error, never the secret. 404 when the team has none.',
    },
  })

  .post(
    '/teams/:teamId/mailbox',
    async ({ params, body, set }) => {
      const created = await createTeamMailbox(params.teamId, body);
      set.status = 201;
      return created;
    },
    {
      params: teamParams,
      body: TeamMailboxCreateBody,
      teamManager: true,
      response: { 201: TeamMailboxDto, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Set up the team mailbox',
        description:
          'Only INBOX is read. Its emails are sent to the AI provider of the chosen agent. The IMAP host must be public.',
      },
    },
  )

  .patch('/teams/:teamId/mailbox', ({ params, body }) => updateTeamMailbox(params.teamId, body), {
    params: teamParams,
    body: TeamMailboxUpdateBody,
    teamManager: true,
    response: { 200: TeamMailboxDto, ...commonErrors, ...errors(404) },
    detail: {
      summary: 'Update the team mailbox',
      description:
        'Replacing the password or the Microsoft 365 credentials starts a paused mailbox again and keeps its read position.',
    },
  })

  .delete(
    '/teams/:teamId/mailbox',
    async ({ params }) => {
      await deleteTeamMailbox(params.teamId);
      return noContent();
    },
    {
      params: teamParams,
      teamManager: true,
      response: { 204: t.Void(), ...accessErrors, ...errors(404) },
      detail: { summary: 'Remove the team mailbox' },
    },
  );
