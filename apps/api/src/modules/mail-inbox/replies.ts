import { aiAgent, db, intakeItem, teamMailbox } from '@repo/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { checkPermission, assertProjectWritable } from '#shared/access';
import { createComment } from '#modules/issues/activity';
import { getIssue } from '#modules/issues/service';
import { moveAttachments } from './attachments';
import { queueTriageRun } from './triage';

// Replies in a thread become issue comments. The worker marks an email that answers an
// accepted one (`reply_to_issue_id`); this posts it, with no triage and no AI. It runs in the
// api because it applies the team agent's rights, which the worker cannot.

// Lines that start the quoted earlier message or the signature. Everything from the first
// such line on is cut.
const CUT_LINES: RegExp[] = [
  /^On .{5,300} wrote:\s*$/i,
  /^Am .{5,300} schrieb .{0,200}:\s*$/i,
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Forwarded message)\s*-{2,}\s*$/i,
  /^_{5,}\s*$/,
  /^-- ?$/,
  /^Sent from my /i,
  /^Von: .+/,
  /^From: .+@.+/,
];

// Cuts quoted lines (`>`), the quoted earlier message and the signature, and returns what the
// sender wrote new.
export function stripReply(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // "On <date>, <name> wrote:" is often wrapped over two lines.
    const joined = `${line.trim()} ${lines[i + 1]?.trim() ?? ''}`.trim();
    if (
      CUT_LINES.some((re) => re.test(line.trim()) || (/^(On|Am) /.test(line) && re.test(joined)))
    ) {
      break;
    }
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

// The text of an outside sender is posted under the team agent's name. A "@handle" in it
// would start a run of that agent with the sender's text as its task, so the mention is broken
// with a zero-width space.
export function withoutMentions(text: string): string {
  return text.replace(/@(?=\w)/g, '@\u200b');
}

type Item = typeof intakeItem.$inferSelect;

// Posts one claimed reply. Returns false when it cannot be posted, so the caller triages it.
async function postReply(item: Item, actorUserId: string): Promise<boolean> {
  const issue = item.replyToIssueId ? await getIssue(item.replyToIssueId) : null;
  if (!issue) return false;
  if (!(await checkPermission(issue.projectId, { id: actorUserId }, 'work_items', 'edit'))) {
    return false;
  }
  try {
    await assertProjectWritable(issue.projectId, 'POST');
  } catch {
    return false;
  }
  const from = item.fromName ? `${item.fromName} <${item.fromAddress}>` : item.fromAddress;
  const text = withoutMentions(stripReply(item.body)) || '(no text)';
  const notes = await moveAttachments(item, issue.projectId, issue.id);
  await createComment({
    issueId: issue.id,
    actorUserId,
    body: [`via email from ${from}`, '', text, ...(notes.length ? ['', ...notes] : [])].join('\n'),
  });
  await db
    .update(intakeItem)
    .set({
      status: 'accepted',
      issueId: issue.id,
      replyToIssueId: null,
      decidedAt: new Date(),
      body: '',
      attachments: [],
    })
    .where(eq(intakeItem.id, item.id));
  return true;
}

// The email goes through triage like a new one: the agent can no longer comment, or the issue
// is gone.
async function fallBackToTriage(item: Item, agentId: number, teamId: number) {
  await db.update(intakeItem).set({ replyToIssueId: null }).where(eq(intakeItem.id, item.id));
  await queueTriageRun(item.id, { agentId, teamId });
}

// Posts the pending replies. Each is claimed by clearing its marker in one conditional update,
// so several api replicas never post one twice. A reply that fails for any reason is triaged
// instead, so none is retried forever or lost.
export async function processMailReplies(): Promise<number> {
  const pending = await db
    .select({
      item: intakeItem,
      actorUserId: aiAgent.userId,
      agentId: teamMailbox.agentId,
      teamId: teamMailbox.teamId,
    })
    .from(intakeItem)
    .innerJoin(teamMailbox, eq(teamMailbox.id, intakeItem.teamMailboxId))
    .innerJoin(aiAgent, eq(aiAgent.id, teamMailbox.agentId))
    .where(and(eq(intakeItem.status, 'new'), isNotNull(intakeItem.replyToIssueId)))
    .orderBy(asc(intakeItem.id))
    .limit(20);
  let posted = 0;
  for (const { item, actorUserId, agentId, teamId } of pending) {
    const claimed = await db
      .update(intakeItem)
      .set({ status: 'accepted' })
      .where(
        and(
          eq(intakeItem.id, item.id),
          eq(intakeItem.status, 'new'),
          isNotNull(intakeItem.replyToIssueId),
        ),
      )
      .returning({ id: intakeItem.id });
    if (claimed.length === 0) continue;
    try {
      if (await postReply(item, actorUserId)) {
        posted++;
        continue;
      }
    } catch (err) {
      console.error(`[mail-inbox] reply ${item.id} not posted:`, err);
    }
    await db.update(intakeItem).set({ status: 'new' }).where(eq(intakeItem.id, item.id));
    await fallBackToTriage(item, agentId, teamId);
  }
  return posted;
}
