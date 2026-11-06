'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/services/queryKeys';
import {
  addMailboxFolder,
  createMailbox,
  deleteMailbox,
  deleteMailboxFolder,
  getMailboxOptions,
  listMailboxes,
  updateMailbox,
  type FolderInput,
  type MailboxInput,
} from '@/lib/api/endpoints/mailboxes';

export const useMailboxesQuery = () => useQuery({ queryKey: qk.mailboxes, queryFn: listMailboxes });

export const useMailboxOptionsQuery = () =>
  useQuery({ queryKey: qk.mailboxOptions, queryFn: getMailboxOptions });

// Every write only needs a fresh list afterwards. A form owns its error text inline, so it
// opts out of the global error toast.
function useMailboxMutation<V>(fn: (v: V) => Promise<unknown>, inlineError = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { suppressErrorToast: inlineError },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mailboxes }),
  });
}

export const useCreateMailbox = () =>
  useMailboxMutation((input: MailboxInput) => createMailbox(input), true);

export const useUpdateMailbox = () =>
  useMailboxMutation(
    (v: { id: number; input: Partial<MailboxInput> }) => updateMailbox(v.id, v.input),
    true,
  );

export const useDeleteMailbox = () => useMailboxMutation((id: number) => deleteMailbox(id));

export const useAddFolder = () =>
  useMailboxMutation(
    (v: { id: number; input: FolderInput }) => addMailboxFolder(v.id, v.input),
    true,
  );

export const useDeleteFolder = () =>
  useMailboxMutation((v: { id: number; folderId: number }) =>
    deleteMailboxFolder(v.id, v.folderId),
  );
