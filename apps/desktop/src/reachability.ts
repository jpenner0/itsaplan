import { net } from 'electron';

const TIMEOUT_MS = 10_000;

/** Returns why the server is unreachable, or undefined when it sent any HTTP response. */
export async function checkReachable(origin: string): Promise<string | undefined> {
  try {
    const response = await net.fetch(origin, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    void response.body?.cancel();
    return undefined;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return `No response within ${TIMEOUT_MS / 1000} seconds.`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
