'use client';

import TeamMailboxSection from '@/features/teams/components/mailbox/TeamMailboxSection';
import { useRouteTeam } from '@/features/teams/hooks/useRouteTeam';

export default function Page() {
  const team = useRouteTeam();
  return team && <TeamMailboxSection teamId={team.id} />;
}
