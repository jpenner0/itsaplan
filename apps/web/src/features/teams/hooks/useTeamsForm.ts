'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { NotificationSettings } from '@/lib/api/endpoints/notificationSettings';
import { useUpdateNotificationSettings } from '@/services/teams.service';

export interface TeamsForm {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
}

// Form state for the Microsoft Teams tab: only the team gate. Webhooks are the members'.
export function useTeamsForm(teamId: number, settings: NotificationSettings): TeamsForm {
  const t = useTranslations('teams.notifications');
  const update = useUpdateNotificationSettings(teamId);
  const [enabled, setEnabled] = useState(settings.teams.enabled);

  async function save() {
    await update.mutateAsync({ teams: { enabled } });
    toast.success(t('teamsSaved'));
  }

  return {
    enabled,
    setEnabled,
    dirty: enabled !== settings.teams.enabled,
    saving: update.isPending,
    save,
  };
}
