'use client';

import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { InstanceGoogleSettings, InstanceGoogleSettingsPatch } from '@/lib/api/endpoints/god';

export interface GodOAuthAppForm {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  // Both credentials are present, counting a stored secret the user has not retyped.
  // The switch stays off without them: the API refuses it, and the provider would
  // otherwise only fail at Google or GitHub.
  hasCredentials: boolean;
  settings: InstanceGoogleSettings;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
}

// Form state for the Google or GitHub OAuth app. Same contract as the mail provider:
// the secret starts blank and an empty field on save keeps the stored one.
export function useGodOAuthAppForm(
  settings: InstanceGoogleSettings,
  update: UseMutationResult<InstanceGoogleSettings, Error, InstanceGoogleSettingsPatch>,
): GodOAuthAppForm {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [clientId, setClientId] = useState(settings.clientId);
  const [clientSecret, setClientSecret] = useState('');

  const hasCredentials =
    clientId.trim().length > 0 && (settings.hasClientSecret || clientSecret.length > 0);
  const dirty =
    enabled !== settings.enabled || clientId !== settings.clientId || clientSecret.length > 0;

  async function save() {
    await update.mutateAsync({
      enabled: enabled && hasCredentials,
      clientId: clientId.trim(),
      ...(clientSecret.length > 0 ? { clientSecret } : {}),
    });
    setClientSecret('');
  }

  return {
    enabled,
    setEnabled,
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
    hasCredentials,
    settings,
    dirty,
    saving: update.isPending,
    save,
  };
}
