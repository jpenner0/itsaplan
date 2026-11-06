import { createRemoteJWKSet } from 'jose';

// The signing keys Microsoft publishes for the requests the Bot Framework sends. Fixed
// address, cached and refreshed by jose. A test replaces this module with a local set.
export const botFrameworkKeys = createRemoteJWKSet(
  new URL('https://login.botframework.com/v1/.well-known/keys'),
);
