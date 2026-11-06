import { pinnedFetch, UrlNotAllowedError } from './index';

// Microsoft Teams Workflows webhooks (Power Automate). The URL carries a signature,
// so it is a secret, and a member supplies it: only Microsoft's own webhook hosts are
// accepted, so a member cannot make the server post project content to another host.
// Requests still go through pinnedFetch, the SSRF guard.

const ALLOWED_HOST_SUFFIXES = ['.logic.azure.com', '.api.powerplatform.com'];

const TIMEOUT_MS = 15_000;

// Returns the parsed URL, or throws UrlNotAllowedError.
export function assertTeamsWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlNotAllowedError('Not a valid URL');
  }
  if (url.protocol !== 'https:') throw new UrlNotAllowedError('The URL must use https');
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new UrlNotAllowedError('The URL must not contain credentials or a custom port');
  }
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UrlNotAllowedError('Not a Teams Workflows webhook URL');
  }
  return url;
}

export interface TeamsCard {
  title: string;
  text: string;
  url?: string;
}

// The Workflows webhook body: a message that carries one Adaptive Card.
export function buildTeamsPayload(card: TeamsCard) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: card.title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: card.text, wrap: true },
          ],
          ...(card.url
            ? { actions: [{ type: 'Action.OpenUrl', title: 'Open', url: card.url }] }
            : {}),
        },
      },
    ],
  };
}

export type TeamsPostResult = { ok: true } | { ok: false; retryable: boolean; error: string };

// Posts one card. A 2xx is success; 429 and 5xx and network errors are transient;
// any other status, or a URL the guard refuses, is permanent.
export async function postTeamsCard(rawUrl: string, card: TeamsCard): Promise<TeamsPostResult> {
  try {
    const url = assertTeamsWebhookUrl(rawUrl);
    const res = await pinnedFetch(url.toString(), {
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildTeamsPayload(card)),
      maxBytes: 4096,
      truncateBody: true,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const body = (await res.text().catch(() => '')).slice(0, 200);
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error: `Teams HTTP ${res.status}: ${body}`,
    };
  } catch (err) {
    if (err instanceof UrlNotAllowedError)
      return { ok: false, retryable: false, error: err.message };
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : 'Teams request failed',
    };
  }
}
