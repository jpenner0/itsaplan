'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { NotificationPreferencesView } from '@/lib/api/endpoints/notificationPreferences';
import type { NotificationEventToggles } from '@/lib/api/endpoints/notificationSettings';
import { useUpdateNotificationPreferences } from '../services/settings.service';
import { eventsEqual } from '../utils/notificationEvents';

export interface NotificationPreferencesForm {
  emailEvents: NotificationEventToggles;
  setEmailEvents: (v: NotificationEventToggles) => void;
  telegramEvents: NotificationEventToggles;
  setTelegramEvents: (v: NotificationEventToggles) => void;
  teamsEvents: NotificationEventToggles;
  setTeamsEvents: (v: NotificationEventToggles) => void;
  teamsEnabled: boolean;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
}

// Form state for the member's own notification preferences. Shared between the
// header Save button and the body checkboxes, so it lives in a hook.
export function useNotificationPreferencesForm(
  projectKey: string,
  initial: NotificationPreferencesView,
): NotificationPreferencesForm {
  const t = useTranslations('settings.notifications');
  const update = useUpdateNotificationPreferences(projectKey);
  const [emailEvents, setEmailEvents] = useState<NotificationEventToggles>(initial.emailEvents);
  const [telegramEvents, setTelegramEvents] = useState<NotificationEventToggles>(
    initial.telegramEvents,
  );
  const [teamsEvents, setTeamsEvents] = useState<NotificationEventToggles>(initial.teamsEvents);

  const dirty =
    !eventsEqual(emailEvents, initial.emailEvents) ||
    !eventsEqual(telegramEvents, initial.telegramEvents) ||
    !eventsEqual(teamsEvents, initial.teamsEvents);

  async function save() {
    await update.mutateAsync({ emailEvents, telegramEvents, teamsEvents });
    toast.success(t('preferencesSaved'));
  }

  return {
    emailEvents,
    setEmailEvents,
    telegramEvents,
    setTelegramEvents,
    teamsEvents,
    setTeamsEvents,
    teamsEnabled: initial.teamsEnabled,
    dirty,
    saving: update.isPending,
    save,
  };
}
