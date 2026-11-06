import { describe, expect, it } from 'bun:test';
import { parseCommand, parseIssueRef, parseProjectRef } from '../../commands';

describe('teams bot command parser', () => {
  it('splits the keyword from the rest and ignores case and spacing', () => {
    expect(parseCommand('  SEARCH   login  bug ')).toEqual({
      keyword: 'search',
      args: 'login  bug',
    });
    expect(parseCommand('my')).toEqual({ keyword: 'my', args: '' });
    expect(parseCommand('   ')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it('reads @KEY, @slug/KEY and @<team-id>/KEY', () => {
    expect(parseProjectRef('@mkt')).toEqual({ key: 'mkt', team: null });
    expect(parseProjectRef('@design/MKT')).toEqual({ key: 'MKT', team: 'design' });
    expect(parseProjectRef('@12/MKT')).toEqual({ key: 'MKT', team: '12' });
    for (const bad of ['MKT', '@', '@a/b/c', '@MKT-1', '@1MKT', '@TOOLONGKEY12']) {
      expect(parseProjectRef(bad)).toBeNull();
    }
  });

  it('reads MKT-42 with an optional team prefix', () => {
    expect(parseIssueRef('mkt-42')).toEqual({ key: 'mkt', team: null, sequenceNumber: 42 });
    expect(parseIssueRef('@design/MKT-7')).toEqual({
      key: 'MKT',
      team: 'design',
      sequenceNumber: 7,
    });
    for (const bad of ['MKT', 'MKT-', 'MKT-x', '42', 'MKT-1234567890']) {
      expect(parseIssueRef(bad)).toBeNull();
    }
  });
});
