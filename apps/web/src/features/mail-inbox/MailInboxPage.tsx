'use client';

import { useTranslations } from 'next-intl';
import FullPageView from '@/components/common/page/FullPageView';
import { Skeleton } from '@/components/ui/skeleton';
import MailInboxItem from './MailInboxItem';
import { useMailInboxProjectsQuery, useMailInboxQuery } from './services/mailInbox.service';

// The user's Mail inbox: draft issues for the emails of their mailboxes. Only they see it.
// The resulting issue is visible to everyone who may see the project.
export default function MailInboxPage() {
  const t = useTranslations('mailInbox');
  const { data, isPending } = useMailInboxQuery();
  const { data: projects } = useMailInboxProjectsQuery();

  return (
    <FullPageView label={t('label')} title={t('title')} description={t('description')}>
      {isPending && <Skeleton className="h-32 w-full" />}
      {data?.items.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      <div className="space-y-4">
        {data?.items.map((item) => (
          <MailInboxItem key={item.id} item={item} projects={projects ?? []} />
        ))}
      </div>
      {data && data.sortedOut.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium">
            {t('sortedOut', { count: data.sortedOut.length })}
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('sortedOutHint')}</p>
          <div className="mt-3 space-y-4">
            {data.sortedOut.map((item) => (
              <MailInboxItem key={item.id} item={item} projects={projects ?? []} />
            ))}
          </div>
        </details>
      )}
    </FullPageView>
  );
}
