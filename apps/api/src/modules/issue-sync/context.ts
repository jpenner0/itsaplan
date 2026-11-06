import { AsyncLocalStorage } from 'node:async_hooks';

// Marks the writes the issue sync makes on It's a Plan's side. The outbound sync reads
// it, so a change that came from the provider is not sent back to it.
const syncWrite = new AsyncLocalStorage<true>();

export function runAsIssueSync<T>(fn: () => Promise<T>): Promise<T> {
  return syncWrite.run(true, fn);
}

export function isIssueSyncWrite(): boolean {
  return syncWrite.getStore() === true;
}
