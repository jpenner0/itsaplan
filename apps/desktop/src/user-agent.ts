/**
 * Removes the `Electron/x.y.z` token and the app-name token from Electron's default user agent.
 * Google sign-in rejects user agents that look like an embedded browser.
 */
export function cleanUserAgent(userAgent: string): string {
  return userAgent
    .replace(/ Electron\/\S+/, '')
    .replace(/(\(KHTML, like Gecko\)) .*? (Chrome\/)/, '$1 $2');
}
