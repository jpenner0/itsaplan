// The retry schedule and the background work shared by the outbox and the inbox.

// The delay doubles from a minute up to an hour, so 20 attempts span about 15 hours.
export const MAX_ATTEMPTS = 20;
const MAX_BACKOFF_MS = 3_600_000;

export function retryAt(attempts: number): Date {
  return new Date(Date.now() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const inFlight = new Set<Promise<void>>();

// Registers work started without awaiting it, so issueSyncSettled can wait for it.
export function track(run: Promise<void>): void {
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run)).catch(() => undefined);
}

// Resolves once every tracked push and inbox run has finished. For tests.
export async function issueSyncSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
