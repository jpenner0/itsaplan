import { pinnedFetch } from './index';
import { buildTeamsPayload, type TeamsCard } from './teams-webhook';

// The Microsoft Teams bot (Azure Bot Service, single tenant). The api receives the
// activities and the worker sends notifications; both need the bot credentials and
// this client. The credentials are environment variables, not instance settings: they
// come from an Azure app registration the operator creates once.

export interface TeamsBotConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
}

export function readTeamsBotConfig(): TeamsBotConfig | null {
  const appId = process.env.TEAMS_BOT_APP_ID?.trim();
  const appPassword = process.env.TEAMS_BOT_APP_PASSWORD?.trim();
  const tenantId = process.env.TEAMS_BOT_TENANT_ID?.trim();
  return appId && appPassword && tenantId ? { appId, appPassword, tenantId } : null;
}

export function isTeamsBotConfigured(): boolean {
  return readTeamsBotConfig() !== null;
}

const TIMEOUT_MS = 15_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

// An app-only token for the Bot Connector, cached until shortly before it expires.
async function getBotToken(config: TeamsBotConfig): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.appId,
        client_secret: config.appPassword,
        scope: 'https://api.botframework.com/.default',
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!res.ok || !body?.access_token) {
    const error = new Error(`Teams bot token request failed: HTTP ${res.status}`);
    (error as Error & { retryable?: boolean }).retryable = res.status === 429 || res.status >= 500;
    throw error;
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

export interface TeamsBotConversation {
  serviceUrl: string;
  conversationId: string;
}

export type TeamsBotSendResult =
  | { ok: true }
  // `gone` is set when the conversation no longer accepts messages (403 or 404): the
  // user removed the bot or the reference is stale, so retrying cannot help.
  | { ok: false; retryable: boolean; error: string; gone: boolean };

// Sends one activity into a conversation. serviceUrl comes from a verified Bot
// Framework request, and pinnedFetch still refuses a non-public address.
async function sendActivity(
  config: TeamsBotConfig,
  conversation: TeamsBotConversation,
  activity: object,
): Promise<TeamsBotSendResult> {
  try {
    const token = await getBotToken(config);
    const base = conversation.serviceUrl.replace(/\/+$/, '');
    const res = await pinnedFetch(
      `${base}/v3/conversations/${encodeURIComponent(conversation.conversationId)}/activities`,
      {
        method: 'POST',
        timeoutMs: TIMEOUT_MS,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(activity),
        maxBytes: 4096,
        truncateBody: true,
      },
    );
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401) cachedToken = null;
    const body = (await res.text().catch(() => '')).slice(0, 200);
    return {
      ok: false,
      retryable: res.status === 401 || res.status === 429 || res.status >= 500,
      error: `Teams bot HTTP ${res.status}: ${body}`,
      gone: res.status === 403 || res.status === 404,
    };
  } catch (err) {
    const retryable = (err as { retryable?: boolean }).retryable ?? true;
    return {
      ok: false,
      retryable,
      error: err instanceof Error ? err.message : 'Teams bot request failed',
      gone: false,
    };
  }
}

export async function sendBotText(
  conversation: TeamsBotConversation,
  text: string,
): Promise<TeamsBotSendResult> {
  const config = readTeamsBotConfig();
  if (!config)
    return { ok: false, retryable: false, error: 'teams bot not configured', gone: false };
  return sendActivity(config, conversation, { type: 'message', text });
}

// The same Adaptive Card the webhook channel sends, as a direct message from the bot.
export async function sendBotCard(
  conversation: TeamsBotConversation,
  card: TeamsCard,
): Promise<TeamsBotSendResult> {
  const config = readTeamsBotConfig();
  if (!config)
    return { ok: false, retryable: false, error: 'teams bot not configured', gone: false };
  return sendActivity(config, conversation, buildTeamsPayload(card));
}
