'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import AccountConnectionRow from './AccountConnectionRow';
import {
  useDisconnectTeamsBot,
  useStartTeamsBotLink,
  useTeamsBotAccountQuery,
} from '@/services/teamsBot.service';

const POLL_INTERVAL_MS = 2000;
// The code lives longer; this only bounds how long the page keeps asking after a user
// who walked away from the flow.
const POLL_TIMEOUT_MS = 3 * 60_000;

// The link to the Teams bot. Connecting shows a one-time code to send to the bot in a
// personal chat; the bot endpoint writes the link, so the page polls until it appears.
export default function AccountTeamsBotConnection() {
  const t = useTranslations('account.accounts');
  const [code, setCode] = useState<string | null>(null);
  const { data } = useTeamsBotAccountQuery(code ? POLL_INTERVAL_MS : undefined);
  const start = useStartTeamsBotLink();
  const disconnect = useDisconnectTeamsBot();

  const link = data?.link && !data.link.broken ? data.link : null;

  useEffect(() => {
    if (!code) return;
    if (link) {
      setCode(null);
      toast.success(t('teamsBotConnected'));
      return;
    }
    const stop = setTimeout(() => setCode(null), POLL_TIMEOUT_MS);
    return () => clearTimeout(stop);
  }, [code, link, t]);

  // No bot credentials on this instance means the bot is not offered at all.
  if (!data?.available) return null;

  async function onConnect() {
    const started = await start.mutateAsync();
    setCode(started.code);
  }

  return (
    <div>
      <AccountConnectionRow
        icon={<Bot className="size-4" />}
        name={t('teamsBotName')}
        description={data.link?.broken ? t('teamsBotBroken') : t('teamsBotDescription')}
        connectedTo={link ? (link.displayName ?? t('telegramConnectedLabel')) : null}
        busy={start.isPending || disconnect.isPending}
        onConnect={() => void onConnect()}
        onDisconnect={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => toast.success(t('teamsBotDisconnected')),
          })
        }
      />
      {code && (
        <div className="flex flex-col gap-2 pb-4 text-sm sm:ms-11">
          <p>{t('teamsBotSteps')}</p>
          <code dir="ltr" className="w-fit rounded bg-muted px-2 py-1">
            link {code}
          </code>
          {data.chatUrl && (
            <Button asChild size="sm" variant="outline" className="w-fit">
              <a href={data.chatUrl} target="_blank" rel="noreferrer">
                {t('teamsBotOpenChat')}
              </a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
