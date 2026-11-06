import { t } from 'elysia';

const EventToggles = t.Object({
  assigned: t.Boolean(),
  mentioned: t.Boolean(),
  commented: t.Boolean(),
  state_changed: t.Boolean(),
});

// Request body of the PUT and the response of both routes.
export const NotificationPreferenceBody = t.Object({
  emailEvents: EventToggles,
  telegramEvents: EventToggles,
  teamsEvents: EventToggles,
});

// The GET also says whether the project's team has turned Teams on, so the client
// shows the Teams column only then.
export const NotificationPreferenceResponse = t.Object({
  ...NotificationPreferenceBody.properties,
  teamsEnabled: t.Boolean(),
});
