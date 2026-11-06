'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/core/client';
import { qk } from '@/services/queryKeys';
import {
  createTeamMailbox,
  deleteTeamMailbox,
  getTeamMailbox,
  updateTeamMailbox,
  type TeamMailbox,
  type TeamMailboxInput,
} from '@/lib/api/endpoints/teamMailbox';

// Pass null for anyone who may not manage the mailbox to skip the request. A team without a
// mailbox answers 404, which is data here: the query resolves to null.
export function useTeamMailboxQuery(teamId: number | null) {
  return useQuery({
    queryKey: qk.teamMailbox(teamId ?? 0),
    queryFn: async () => {
      try {
        return await getTeamMailbox(teamId!);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: teamId != null,
  });
}

// The form shows a failed save inline, so the global error toast is off.
export function useSaveTeamMailbox(teamId: number, exists: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TeamMailboxInput) =>
      exists ? updateTeamMailbox(teamId, input) : createTeamMailbox(teamId, input),
    meta: { suppressErrorToast: true },
    onSuccess: (data: TeamMailbox) => qc.setQueryData(qk.teamMailbox(teamId), data),
  });
}

export function useDeleteTeamMailbox(teamId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteTeamMailbox(teamId),
    onSuccess: () => qc.setQueryData(qk.teamMailbox(teamId), null),
  });
}
