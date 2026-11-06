// Decides whether an email may enter the intake: its sender is on the team's list and the
// receiving server vouched for the From domain. No database and no network.

interface AuthResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

// Header lines of the message, unfolded, in order. Only the header block is read.
function headerLines(source: Buffer): [name: string, value: string][] {
  const text = source.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = end === -1 ? text : text.slice(0, end);
  const out: [string, string][] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1]![1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) out.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1)]);
  }
  return out;
}

// Parses the value of one Authentication-Results header (RFC 8601). The first part is the
// id of the server that wrote it and is skipped.
export function parseAuthenticationResults(value: string): AuthResult[] {
  const out: AuthResult[] = [];
  for (const part of value
    .replace(/\([^)]*\)/g, ' ')
    .split(';')
    .slice(1)) {
    const tokens = part.trim().split(/\s+/);
    const [method, result] = (tokens[0] ?? '').toLowerCase().split('=');
    if (!method || !result) continue;
    const props = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq > 0) props.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1).toLowerCase());
    }
    out.push({ method, result, props });
  }
  return out;
}

// True when the topmost Authentication-Results header, the one the receiving server added
// last, shows a pass for the domain of `fromAddress`: dmarc, or spf or dkim with the same
// domain. Headers below it can be written by the sender and are ignored. An email with
// more than one From header is never authenticated, as parsers disagree on which one counts.
export function isSenderAuthenticated(source: Buffer, fromAddress: string): boolean {
  const lines = headerLines(source);
  if (lines.filter(([name]) => name === 'from').length !== 1) return false;
  const top = lines.find(([name]) => name === 'authentication-results');
  if (!top || !fromAddress.includes('@')) return false;
  const domain = domainOf(fromAddress.toLowerCase());
  return parseAuthenticationResults(top[1]).some(({ method, result, props }) => {
    if (result !== 'pass') return false;
    if (method === 'dmarc') return !props.has('header.from') || props.get('header.from') === domain;
    if (method === 'spf') {
      const from = props.get('smtp.mailfrom');
      return from !== undefined && domainOf(from) === domain;
    }
    return method === 'dkim' && props.get('header.d') === domain;
  });
}

// An entry is a full address or a domain; a domain matches that domain only, not its
// subdomains. An empty list lets nobody in.
export function isSenderListed(allowed: string[], fromAddress: string): boolean {
  const address = fromAddress.toLowerCase();
  if (!address.includes('@')) return false;
  const domain = domainOf(address);
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^@/, '');
    return e === address || (!e.includes('@') && e === domain);
  });
}
