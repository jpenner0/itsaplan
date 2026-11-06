import { describe, expect, it } from 'bun:test';
import { isSenderAuthenticated, isSenderListed, parseAuthenticationResults } from '../../mail-auth';

const mail = (headers: string[], from = 'a@example.com') =>
  Buffer.from(`${headers.join('\r\n')}\r\nFrom: ${from}\r\nSubject: x\r\n\r\nbody`);

describe('parseAuthenticationResults', () => {
  it('reads methods, results and properties and ignores comments', () => {
    const r = parseAuthenticationResults(
      'mx.example.net; spf=PASS (ip ok) smtp.mailfrom=Bounce@Example.com; dkim=fail header.d=x.test',
    );
    expect(r.map((x) => [x.method, x.result])).toEqual([
      ['spf', 'pass'],
      ['dkim', 'fail'],
    ]);
    expect(r[0]!.props.get('smtp.mailfrom')).toBe('bounce@example.com');
  });
});

describe('isSenderAuthenticated', () => {
  const ok = (h: string, from?: string) =>
    isSenderAuthenticated(mail([h], from), from ?? 'a@example.com');

  it('accepts dmarc pass, and spf or dkim pass for the same domain', () => {
    expect(ok('Authentication-Results: mx; dmarc=pass header.from=example.com')).toBe(true);
    expect(ok('Authentication-Results: mx; spf=pass smtp.mailfrom=x@example.com')).toBe(true);
    expect(ok('Authentication-Results: mx; dkim=pass header.d=EXAMPLE.com')).toBe(true);
  });

  it('rejects a failed check, a missing header and a pass for another domain', () => {
    expect(ok('Authentication-Results: mx; dmarc=fail header.from=example.com')).toBe(false);
    expect(ok('Authentication-Results: mx; dmarc=none')).toBe(false);
    expect(ok('X-Other: 1')).toBe(false);
    expect(ok('Authentication-Results: mx; dkim=pass header.d=evil.test')).toBe(false);
    expect(ok('Authentication-Results: mx; spf=pass smtp.mailfrom=a@bounce.example.com')).toBe(
      false,
    );
    expect(ok('Authentication-Results: mx; dmarc=pass header.from=evil.test')).toBe(false);
  });

  it('uses only the topmost Authentication-Results header', () => {
    const forged = mail([
      'Authentication-Results: mx; dmarc=fail',
      'Authentication-Results: spoof; dmarc=pass header.from=example.com',
    ]);
    expect(isSenderAuthenticated(forged, 'a@example.com')).toBe(false);
  });

  it('handles a folded header and ignores text in the body', () => {
    const folded = mail(['Authentication-Results: mx;', ' dmarc=pass', ' header.from=example.com']);
    expect(isSenderAuthenticated(folded, 'a@example.com')).toBe(true);
    const body = Buffer.from('From: a@example.com\r\n\r\nAuthentication-Results: mx; dmarc=pass');
    expect(isSenderAuthenticated(body, 'a@example.com')).toBe(false);
  });

  it('rejects an email with two From headers', () => {
    const two = Buffer.from(
      'Authentication-Results: mx; dmarc=pass header.from=example.com\r\nFrom: a@example.com\r\nFrom: b@evil.test\r\n\r\nx',
    );
    expect(isSenderAuthenticated(two, 'a@example.com')).toBe(false);
  });
});

describe('isSenderListed', () => {
  it('matches an address or a domain, ignoring case', () => {
    expect(isSenderListed(['A@Example.com'], 'a@example.com')).toBe(true);
    expect(isSenderListed(['example.com'], 'x@EXAMPLE.com')).toBe(true);
    expect(isSenderListed(['@example.com'], 'x@example.com')).toBe(true);
  });

  it('does not match a subdomain, a suffix, another address or an empty list', () => {
    expect(isSenderListed(['example.com'], 'x@mail.example.com')).toBe(false);
    expect(isSenderListed(['example.com'], 'x@notexample.com')).toBe(false);
    expect(isSenderListed(['a@example.com'], 'b@example.com')).toBe(false);
    expect(isSenderListed([], 'a@example.com')).toBe(false);
    expect(isSenderListed(['example.com'], '')).toBe(false);
  });
});
