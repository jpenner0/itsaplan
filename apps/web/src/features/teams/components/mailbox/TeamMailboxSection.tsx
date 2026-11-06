'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useTeam } from '@/services/teams.service';
import SectionPageView from '@/components/common/page/SectionPageView';
import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import { useTeamMailboxQuery } from '../../services/teamMailbox.service';
import TeamMailboxForm from './TeamMailboxForm';

// The team's mailbox for the email intake. Its owner and managers set it up and change it;
// anyone else gets a notice, and no request is sent for them.
export default function TeamMailboxSection({ teamId }: { teamId: number }) {
  const t = useTranslations('teams');
  const team = useTeam(teamId);
  const canManage = team?.role === 'owner' || team?.role === 'manager';
  const { data } = useTeamMailboxQuery(canManage ? teamId : null);

  let body: ReactNode;
  if (team && !canManage) {
    body = <p className="text-sm text-muted-foreground">{t('mailbox.managerOnly')}</p>;
  } else if (data === undefined) {
    body = <ListSkeleton rows={3} rowClassName="h-12" />;
  } else {
    body = <TeamMailboxForm teamId={teamId} mailbox={data} />;
  }

  return (
    <SectionPageView
      title={t('sections.mailbox.title')}
      description={t('sections.mailbox.description')}
    >
      {body}
    </SectionPageView>
  );
}
