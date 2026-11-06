// The command grammar of the Teams bot: a fixed keyword, then the rest of the line.
// Free text is never interpreted. The write commands share these parsers.

export interface ParsedCommand {
  keyword: string;
  args: string;
}

export function parseCommand(text: string | undefined): ParsedCommand | null {
  const match = text?.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { keyword: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

// `@KEY`, `@slug/KEY` or `@<team-id>/KEY`. The team part is a slug or a numeric id.
export interface ProjectRef {
  key: string;
  team: string | null;
}

const KEY = '[A-Za-z][A-Za-z0-9]{0,9}';
const TEAM = '[A-Za-z0-9][A-Za-z0-9-]{0,39}';

export function parseProjectRef(text: string): ProjectRef | null {
  const match = text.match(new RegExp(`^@(?:(${TEAM})/)?(${KEY})$`));
  return match ? { key: match[2], team: match[1] ?? null } : null;
}

// `MKT-42`, or `@slug/MKT-42` when several projects share the key.
export interface IssueRef extends ProjectRef {
  sequenceNumber: number;
}

export function parseIssueRef(text: string): IssueRef | null {
  const match = text.match(new RegExp(`^(?:@(${TEAM})/)?(${KEY})-(\\d{1,9})$`));
  return match ? { team: match[1] ?? null, key: match[2], sequenceNumber: Number(match[3]) } : null;
}
