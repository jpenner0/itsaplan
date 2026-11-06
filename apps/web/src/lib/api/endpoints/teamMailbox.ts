import { request } from '@/lib/api/core/client';

// The team's one mailbox for the email intake. The API never returns a password or a client
// secret; `hasSecret` says one is stored.

export type MailboxAuth = 'password' | 'microsoft365';

export interface TeamMailbox {
  host: string;
  port: number;
  secure: boolean;
  auth: MailboxAuth;
  username: string;
  tenantId: string | null;
  clientId: string | null;
  hasSecret: boolean;
  agentId: number;
  agentName: string;
  allowedSenders: string[];
  status: 'active' | 'paused';
  lastError: string | null;
  lastPolledAt: string | null;
}

export interface TeamMailboxInput {
  host: string;
  port: number;
  secure: boolean;
  auth: MailboxAuth;
  username: string;
  agentId: number;
  allowedSenders: string[];
  password?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}

const path = (teamId: number) => `/teams/${teamId}/mailbox`;

export const getTeamMailbox = (teamId: number) => request<TeamMailbox>(path(teamId));
export const createTeamMailbox = (teamId: number, input: TeamMailboxInput) =>
  request<TeamMailbox>(path(teamId), { method: 'POST', body: JSON.stringify(input) });
export const updateTeamMailbox = (teamId: number, input: Partial<TeamMailboxInput>) =>
  request<TeamMailbox>(path(teamId), { method: 'PATCH', body: JSON.stringify(input) });
export const deleteTeamMailbox = (teamId: number) =>
  request<void>(path(teamId), { method: 'DELETE' });
