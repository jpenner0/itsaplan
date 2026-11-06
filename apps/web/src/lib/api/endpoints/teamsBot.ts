import { request } from '@/lib/api/core/client';

// The session user's link to the Microsoft Teams bot. `available` is false when the
// instance has no bot configured, which is when it is not offered at all.
export interface TeamsBotAccount {
  available: boolean;
  chatUrl: string | null;
  link: { displayName: string | null; linkedAt: string; broken: boolean } | null;
}

// The one-time code the user sends to the bot, the chat that opens it, and its expiry.
export interface TeamsBotLinkStart {
  code: string;
  chatUrl: string;
  expiresAt: string;
}

export const getTeamsBotAccount = () => request<TeamsBotAccount>('/teams-bot/account');

export const startTeamsBotLink = () =>
  request<TeamsBotLinkStart>('/teams-bot/account/link', { method: 'POST' });

export const unlinkTeamsBotAccount = () =>
  request<void>('/teams-bot/account', { method: 'DELETE' });
