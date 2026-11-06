// Text of a reply that is added as a comment. The worker marks an email that answers an
// accepted one (`reply_to_issue_id`); a member decides in the inbox whether it becomes a comment.

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
