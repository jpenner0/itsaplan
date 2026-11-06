'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import SecretInput from '@/components/common/inputs/SecretInput';
import {
  useDisconnectTeamsWebhook,
  useSaveTeamsWebhook,
  useTeamsWebhookQuery,
} from '@/services/teamsWebhook.service';

const DOCS_URL = 'https://github.com/jpenner0/itsaplan/blob/main/docs/teams-notifications.md';

// The member's Microsoft Teams Workflows webhook. The URL is a secret and is never
// shown again: once saved, the row shows its host only. A broken connection asks for
// the URL again.
export default function AccountTeamsConnection() {
  const t = useTranslations('account.accounts');
  const { data } = useTeamsWebhookQuery();
  const save = useSaveTeamsWebhook();
  const disconnect = useDisconnectTeamsWebhook();
  const [url, setUrl] = useState('');

  const showForm = !data?.connected || data.broken;
  let description = t('teamsDescription');
  if (data?.broken) description = t('teamsBroken', { error: data.lastError ?? '' });
  else if (data?.connected) description = data.host ?? '';

  async function onSave() {
    await save.mutateAsync(url.trim());
    setUrl('');
    toast.success(t('teamsConnected'));
  }

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <MessagesSquare className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">Microsoft Teams</div>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {data?.connected && (
          <Button
            variant="outline"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(undefined, {
                onSuccess: () => toast.success(t('teamsDisconnected')),
              })
            }
          >
            {t('disconnect')}
          </Button>
        )}
      </div>

      {showForm && (
        <div className="flex flex-col gap-2 sm:ms-11 sm:max-w-xl">
          <div className="flex gap-2">
            <div className="flex-1">
              <SecretInput
                id="teams-webhook-url"
                value={url}
                onChange={setUrl}
                hasStored={false}
                placeholder="https://prod-00.westus.logic.azure.com/workflows/…"
              />
            </div>
            <Button
              size="sm"
              disabled={url.trim().length === 0 || save.isPending}
              onClick={() => void onSave()}
            >
              {t('teamsSave')}
            </Button>
          </div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline"
          >
            {t('teamsHelp')}
          </a>
        </div>
      )}
    </div>
  );
}
