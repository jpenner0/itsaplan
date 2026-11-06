import { startPollLoop, type WorkerHandle } from './poll-loop';
import { pollFolder } from './mail-sync';
import { claimDueFolders, deleteExpiredRejected } from './mail-store';

// Polls the mailbox folders of the email intake. A folder is due every five minutes; the loop
// ticks more often so a folder added or reconnected is read soon.
const TICK_MS = 30_000;

export function startMailWorker(): WorkerHandle {
  return startPollLoop('mail', tick, () => TICK_MS);
}

async function tick(): Promise<void> {
  const folders = await claimDueFolders();
  await Promise.all(folders.map((f) => pollFolder(f)));
  await deleteExpiredRejected();
}
