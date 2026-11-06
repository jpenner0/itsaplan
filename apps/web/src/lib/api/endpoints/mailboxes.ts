import { request } from '@/lib/api/core/client';

// The session user's own mailboxes for the email intake. The API never returns a password
// or a client secret; `hasSecret` says one is stored.

export type MailboxAuth = 'password' | 'microsoft365';

export interface MailboxFolder {
  id: number;
  name: string;
  teamId: number;
  teamName: string;
  agentId: number;
  agentName: string;
  status: 'active' | 'paused';
  lastError: string | null;
  lastPolledAt: string | null;
}

export interface Mailbox {
  id: number;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  auth: MailboxAuth;
  username: string;
  tenantId: string | null;
  clientId: string | null;
  hasSecret: boolean;
  folders: MailboxFolder[];
}

export interface MailboxInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  auth: MailboxAuth;
  username: string;
  password?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface FolderInput {
  name: string;
  teamId: number;
  agentId: number;
}

export interface MailboxOptions {
  teams: { id: number; name: string; agents: { id: number; name: string }[] }[];
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const listMailboxes = () => request<Mailbox[]>('/account/mailboxes');
export const getMailboxOptions = () => request<MailboxOptions>('/account/mailboxes/options');
export const createMailbox = (input: MailboxInput) =>
  request<Mailbox>('/account/mailboxes', json('POST', input));
export const updateMailbox = (id: number, input: Partial<MailboxInput>) =>
  request<Mailbox>(`/account/mailboxes/${id}`, json('PATCH', input));
export const deleteMailbox = (id: number) =>
  request<void>(`/account/mailboxes/${id}`, json('DELETE'));
export const addMailboxFolder = (id: number, input: FolderInput) =>
  request<Mailbox>(`/account/mailboxes/${id}/folders`, json('POST', input));
export const deleteMailboxFolder = (id: number, folderId: number) =>
  request<void>(`/account/mailboxes/${id}/folders/${folderId}`, json('DELETE'));
