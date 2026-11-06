import { startPollLoop, type WorkerHandle } from './poll-loop';
import { pollMailbox } from './mail-sync';
import { claimDueMailboxes, deleteExpiredRejected } from './mail-store';

// Polls the team mailboxes of the email intake. A mailbox is due every five minutes; the loop
// ticks more often so a mailbox added or reconnected is read soon.
const TICK_MS = 30_000;

export function startMailWorker(): WorkerHandle {
  return startPollLoop('mail', tick, () => TICK_MS);
}

async function tick(): Promise<void> {
  const ids = await claimDueMailboxes();
  await Promise.all(ids.map((id) => pollMailbox(id)));
  await deleteExpiredRejected();
}
