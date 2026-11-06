// Pure rules for what a page may do in the shell. They take no Electron or Bun API so `bun test`
// runs them.
import { isHttpUrl } from './server-url';

// Permissions the instance page may use. Reading the clipboard serves the "paste" actions in
// settings. Both are granted only to the instance origin, not to a site the window navigated to.
const INSTANCE_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

export function isPermissionAllowed(
  permission: string,
  requestingUrl: string,
  serverUrl: string | undefined,
): boolean {
  if (!serverUrl || !INSTANCE_PERMISSIONS.has(permission)) return false;
  return URL.parse(requestingUrl)?.origin === URL.parse(serverUrl)?.origin;
}

/**
 * The Trello authorize page answers the opener with postMessage, so it needs a popup that
 * keeps the opener. A popup sent to the system browser has no opener and the token is lost.
 */
export function isAppPopupUrl(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed?.origin === 'https://trello.com' && parsed.pathname === '/1/authorize';
}

// Telegram deep-link pages. The instance sets `window.location` to one after the new tab it
// asked for was refused, which would replace the app page with a Telegram page.
const EXTERNAL_ONLY_HOSTS = new Set(['t.me', 'telegram.me']);

export function isExternalOnlyUrl(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed?.protocol === 'https:' && EXTERNAL_ONLY_HOSTS.has(parsed.hostname);
}

/** Whether a navigation of the window itself may proceed. */
export function isNavigationAllowed(url: string): boolean {
  return isHttpUrl(url) && !isExternalOnlyUrl(url);
}
