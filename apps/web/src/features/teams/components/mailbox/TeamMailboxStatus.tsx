import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { TeamMailbox } from '@/lib/api/endpoints/teamMailbox';

// Whether the mailbox is read, when it was last read and why it stopped.
export default function TeamMailboxStatus({ mailbox }: { mailbox: TeamMailbox }) {
  const t = useTranslations('teams.mailbox');
  const format = useFormatter();
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={mailbox.status === 'paused' ? 'destructive' : 'secondary'}>
          {t(mailbox.status === 'paused' ? 'paused' : 'active')}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {mailbox.lastPolledAt
            ? t('lastPolled', { time: format.relativeTime(new Date(mailbox.lastPolledAt)) })
            : t('neverPolled')}
        </span>
      </div>
      {mailbox.lastError && <p className="text-xs text-destructive">{mailbox.lastError}</p>}
    </div>
  );
}
