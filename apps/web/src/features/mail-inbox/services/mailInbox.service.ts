'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/services/queryKeys';
import {
  acceptMailItem,
  commentMailItem,
  getMailInbox,
  getMailInboxCount,
  getMailInboxProjects,
  rejectMailItem,
  retriageMailItem,
  type AcceptInput,
} from '@/lib/api/endpoints/mailInbox';

// New emails arrive from a worker, so there is no live scope to watch: the list and the
// counter are polled.
const REFRESH_MS = 30_000;

export const useMailInboxQuery = () =>
  useQuery({ queryKey: qk.mailInbox, queryFn: getMailInbox, refetchInterval: REFRESH_MS });

export const useMailInboxProjectsQuery = () =>
  useQuery({ queryKey: qk.mailInboxProjects, queryFn: getMailInboxProjects });

export const useMailInboxCount = () =>
  useQuery({
    queryKey: qk.mailInboxCount,
    queryFn: getMailInboxCount,
    refetchInterval: REFRESH_MS,
  });

function useItemMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { suppressErrorToast: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.mailInbox });
      void qc.invalidateQueries({ queryKey: qk.mailInboxCount });
    },
  });
}

export const useAcceptMailItem = () =>
  useItemMutation((v: { id: number; input: AcceptInput }) => acceptMailItem(v.id, v.input));
export const useCommentMailItem = () =>
  useItemMutation((v: { id: number; issueId: number }) => commentMailItem(v.id, v.issueId));
export const useRejectMailItem = () => useItemMutation((id: number) => rejectMailItem(id));
export const useRetriageMailItem = () => useItemMutation((id: number) => retriageMailItem(id));
