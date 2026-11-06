import { request } from '@/lib/api/core/client';
import type { NotificationEventToggles } from '@/lib/api/endpoints/notificationSettings';

// The session member's own notification preferences for a project: which issue
// events they want by email, Telegram and/or Teams. Email is sent to the member's account
// address, Telegram to the account they linked in their profile.
export interface NotificationPreferences {
  emailEvents: NotificationEventToggles;
  telegramEvents: NotificationEventToggles;
  teamsEvents: NotificationEventToggles;
}

// What the GET returns: also whether the project's team has turned Teams on. The PUT
// does not carry it.
export interface NotificationPreferencesView extends NotificationPreferences {
  teamsEnabled: boolean;
}

// The session member's own notification preferences for a project (any member).
export const getNotificationPreferences = (projectKey: string) =>
  request<NotificationPreferencesView>(`/projects/${projectKey}/notification-preferences`);

export const setNotificationPreferences = (projectKey: string, input: NotificationPreferences) =>
  request<NotificationPreferences>(`/projects/${projectKey}/notification-preferences`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
