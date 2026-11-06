'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteTeamsWebhook,
  getTeamsWebhook,
  saveTeamsWebhook,
} from '@/lib/api/endpoints/teamsWebhook';
import { qk } from '@/services/queryKeys';

export function useTeamsWebhookQuery() {
  return useQuery({ queryKey: qk.teamsWebhook, queryFn: () => getTeamsWebhook() });
}

export function useSaveTeamsWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => saveTeamsWebhook(url),
    onSuccess: (data) => qc.setQueryData(qk.teamsWebhook, data),
  });
}

export function useDisconnectTeamsWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteTeamsWebhook(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.teamsWebhook }),
  });
}
