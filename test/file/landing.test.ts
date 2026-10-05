import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalLanding } from '../../src/file/landing.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';

describe('canonical landing', () => {
  test('a missing tail is the real ancestor plus that tail, and a symlink is refused', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-land-')));
    const lobby = join(root, 'missing', 'lobby');
    expect(canonicalLanding(lobby)).toBe(join(root, 'missing', 'lobby'));
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'file'), 'x');
    expect(canonicalLanding(join(root, 'real', 'file'))).toBe(join(root, 'real', 'file'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(canonicalLanding(join(root, 'link'))).toBeNull();
    expect(canonicalLanding(join(root, 'link', 'file'))).toBeNull();
  });

  test('the lobby is under the config home', () => {
    expect(lobbyDir('/home/owner')).toBe('/home/owner/.config/team/lobby');
  });
});
