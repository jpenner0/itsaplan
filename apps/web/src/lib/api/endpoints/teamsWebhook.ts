import { request } from '@/lib/api/core/client';

// The session user's Microsoft Teams Workflows webhook. The URL itself is never
// returned: only whether one is saved, its host, and whether Teams refused it.
export interface TeamsWebhook {
  connected: boolean;
  host: string | null;
  broken: boolean;
  lastError: string | null;
}

export const getTeamsWebhook = () => request<TeamsWebhook>('/teams-webhook');

export const saveTeamsWebhook = (url: string) =>
  request<TeamsWebhook>('/teams-webhook', { method: 'PUT', body: JSON.stringify({ url }) });

export const deleteTeamsWebhook = () => request<void>('/teams-webhook', { method: 'DELETE' });
