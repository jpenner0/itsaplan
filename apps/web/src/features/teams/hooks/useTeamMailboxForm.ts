'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { MailboxAuth, TeamMailbox, TeamMailboxInput } from '@/lib/api/endpoints/teamMailbox';
import { useSaveTeamMailbox } from '../services/teamMailbox.service';

export interface TeamMailboxFormState {
  host: string;
  setHost: (v: string) => void;
  port: string;
  setPort: (v: string) => void;
  secure: boolean;
  setSecure: (v: boolean) => void;
  auth: MailboxAuth;
  setAuth: (v: MailboxAuth) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  tenantId: string;
  setTenantId: (v: string) => void;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  agentId: string;
  setAgentId: (v: string) => void;
  senders: string;
  setSenders: (v: string) => void;
  valid: boolean;
  saving: boolean;
  error: string | null;
  save: () => Promise<void>;
}

// One address or `@domain` per line; commas and spaces separate too.
export const parseSenders = (text: string) => [...new Set(text.split(/[\s,;]+/).filter(Boolean))];

// Form state for the team mailbox. Secrets start blank and are sent only when typed; a
// secret is required to create the mailbox and when the sign-in mode changes.
export function useTeamMailboxForm(teamId: number, mailbox?: TeamMailbox): TeamMailboxFormState {
  const t = useTranslations('teams.mailbox');
  const mutation = useSaveTeamMailbox(teamId, mailbox !== undefined);
  const [host, setHost] = useState(mailbox?.host ?? '');
  const [port, setPort] = useState(String(mailbox?.port ?? 993));
  const [secure, setSecure] = useState(mailbox?.secure ?? true);
  const [auth, setAuth] = useState<MailboxAuth>(mailbox?.auth ?? 'password');
  const [username, setUsername] = useState(mailbox?.username ?? '');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState(mailbox?.tenantId ?? '');
  const [clientId, setClientId] = useState(mailbox?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [agentId, setAgentId] = useState(mailbox ? String(mailbox.agentId) : '');
  const [senders, setSenders] = useState(mailbox?.allowedSenders.join('\n') ?? '');

  const needsSecret = !mailbox || auth !== mailbox.auth;
  const secretOk =
    auth === 'password'
      ? !needsSecret || password !== ''
      : tenantId.trim() !== '' && clientId.trim() !== '' && (!needsSecret || clientSecret !== '');
  const valid =
    host.trim() !== '' && username.trim() !== '' && Number(port) > 0 && agentId !== '' && secretOk;

  async function save() {
    const input: TeamMailboxInput = {
      host: host.trim(),
      port: Number(port),
      secure,
      auth,
      username: username.trim(),
      agentId: Number(agentId),
      allowedSenders: parseSenders(senders),
    };
    if (auth === 'password') {
      if (password !== '') input.password = password;
    } else {
      input.tenantId = tenantId.trim();
      input.clientId = clientId.trim();
      if (clientSecret !== '') input.clientSecret = clientSecret;
    }
    await mutation.mutateAsync(input);
    setPassword('');
    setClientSecret('');
    toast.success(t('saved'));
  }

  return {
    host,
    setHost,
    port,
    setPort,
    secure,
    setSecure,
    auth,
    setAuth,
    username,
    setUsername,
    password,
    setPassword,
    tenantId,
    setTenantId,
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
    agentId,
    setAgentId,
    senders,
    setSenders,
    valid,
    saving: mutation.isPending,
    error: mutation.error?.message ?? null,
    save,
  };
}
