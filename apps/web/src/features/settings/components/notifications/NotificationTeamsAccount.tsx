'use client';

import Link from 'next/link';
import { MessagesSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SettingsSection from '@/components/common/page/SettingsSection';
import { useTeamsWebhookQuery } from '@/services/teamsWebhook.service';
import { useTranslations } from 'next-intl';

// Where the member's Teams notifications go: the webhook saved in their profile, the
// same for every project. This only shows its state, or sends them to connect one.
export default function NotificationTeamsAccount() {
  const t = useTranslations('settings.notifications');
  const tAccounts = useTranslations('account.accounts');
  const { data } = useTeamsWebhookQuery();
  const ready = data?.connected && !data.broken;

  return (
    <SettingsSection title={t('teamsAccount')} description={t('teamsAccountHint')}>
      <div className="flex items-center justify-between gap-6 rounded-lg border border-border p-4 sm:max-w-md">
        <div className="flex min-w-0 items-center gap-3">
          <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">
            {ready ? data.host : data?.broken ? t('teamsBroken') : t('noTeamsWebhook')}
          </span>
        </div>
        {!ready && (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link href="/account/accounts">{tAccounts('connect')}</Link>
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}
