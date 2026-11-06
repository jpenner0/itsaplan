import { Elysia } from 'elysia';
import { guards } from '#shared/guards';
import { authContext } from '#shared/auth-context';
import { requireUser } from '#shared/access';
import { accessErrors, commonErrors } from '#shared/responses';
import { NotificationPreferenceBody, NotificationPreferenceResponse } from './model';
import { readRedactedSettings } from '#modules/notification-settings/service';
import { getPreferences, setPreferences } from './service';

// A member's own notification preferences for a project: which issue events they want
// by email and/or Telegram. Every route is self-scoped to the session user, so bare
// project membership is enough (no admin gate) — a member only ever reads or writes
// their own row. The project's provider credentials are a separate, owner-only
// concern (notification-settings), and the Telegram chat to reach the member at comes
// from their linked account (/telegram/account), not from here.
export const notificationPreferenceRoutes = new Elysia({
  name: 'notification-preferences',
  detail: { tags: ['Settings'] },
})
  .use(authContext)
  .use(guards)

  .get(
    '/projects/:projectKey/notification-preferences',
    async ({ project, user }) => ({
      ...(await getPreferences(requireUser(user).id, project.id)),
      teamsEnabled: (await readRedactedSettings(project.teamId)).teams.enabled,
    }),
    {
      projectMember: true,
      response: { 200: NotificationPreferenceResponse, ...accessErrors },
      detail: {
        summary: 'Get notification preferences',
        description: "Get the current user's notification preferences for a project.",
      },
    },
  )

  .put(
    '/projects/:projectKey/notification-preferences',
    ({ project, user, body }) => setPreferences(requireUser(user).id, project.id, body),
    {
      body: NotificationPreferenceBody,
      projectMember: true,
      response: { 200: NotificationPreferenceBody, ...commonErrors },
      detail: {
        summary: 'Update notification preferences',
        description: "Update the current user's notification preferences for a project.",
      },
    },
  );
