import { request } from '@/lib/api/core/client';

// The session user's Mail inbox: the drafts of the emails fetched from their own mailboxes.

export type Classification = 'bug' | 'feature' | 'question' | 'no_ticket' | 'spam';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export interface MailDraft {
  projectId: number;
  projectKey: string;
  projectName: string;
  title: string;
  description: string;
  labelIds: number[];
  priority: Priority | null;
  duplicate: { id: number; identifier: string; title: string } | null;
}

export interface MailItem {
  id: number;
  fromName: string;
  fromAddress: string;
  subject: string;
  sentAt: string | null;
  body: string;
  attachments: { filename: string; sizeBytes: number; stored: boolean }[];
  classification: Classification | null;
  folderName: string;
  teamId: number;
  triage: 'none' | 'pending' | 'done' | 'failed';
  draft: MailDraft | null;
}

export interface MailInbox {
  items: MailItem[];
  sortedOut: MailItem[];
}

export interface MailInboxProject {
  id: number;
  key: string;
  name: string;
  teamId: number;
  labels: { id: number; name: string; color: string }[];
}

export interface AcceptInput {
  projectId: number;
  title: string;
  description: string;
  labelIds: number[];
  priority: Priority | null;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const getMailInbox = () => request<MailInbox>('/account/mail-inbox');
export const getMailInboxCount = () =>
  request<{ open: number; enabled: boolean }>('/account/mail-inbox/count');
export const getMailInboxProjects = () =>
  request<MailInboxProject[]>('/account/mail-inbox/projects');
export const acceptMailItem = (id: number, input: AcceptInput) =>
  request<{ issueId: number; identifier: string }>(`/account/mail-inbox/${id}/accept`, post(input));
export const commentMailItem = (id: number, issueId: number) =>
  request<{ issueId: number; identifier: string }>(
    `/account/mail-inbox/${id}/comment`,
    post({ issueId }),
  );
export const rejectMailItem = (id: number) =>
  request<void>(`/account/mail-inbox/${id}/reject`, post());
export const retriageMailItem = (id: number) =>
  request<unknown>(`/account/mail-inbox/${id}/retriage`, post());
