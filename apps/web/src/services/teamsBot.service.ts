'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getTeamsBotAccount,
  startTeamsBotLink,
  unlinkTeamsBotAccount,
} from '@/lib/api/endpoints/teamsBot';
import { qk } from '@/services/queryKeys';

// `pollMs` turns on polling while a link is in progress: the bot endpoint writes the
// link when the user sends the code in Teams, so the page only learns by asking again.
export function useTeamsBotAccountQuery(pollMs?: number) {
  return useQuery({
    queryKey: qk.teamsBotAccount,
    queryFn: () => getTeamsBotAccount(),
    refetchInterval: pollMs ?? false,
  });
}

export function useStartTeamsBotLink() {
  return useMutation({ mutationFn: () => startTeamsBotLink() });
}

export function useDisconnectTeamsBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unlinkTeamsBotAccount(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.teamsBotAccount }),
  });
}
