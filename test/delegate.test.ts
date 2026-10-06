import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADD_DELEGATE_EDIT, delegateGate, logDelegated } from '../src/delegate.ts';
import type { TeamFile } from '../src/file/types.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the gate signature the commands call', () => {
  test('a call is refused until the checks decide, and an add that would edit has its own refusal', () => {
    const verdict = delegateGate({
      command: 'up',
      team: { delegates: null } as TeamFile,
      root: '/proj',
      dir: '/proj/.agents',
      flags: [],
      io: { env: {}, stdinIsTTY: true },
    });
    expect(verdict.kind).toBe('refused');
    expect(ADD_DELEGATE_EDIT).toEqual({
      id: 'add.delegate-edit',
      text: 'the approved delegate cannot change the file or the approval; the owner adds a missing or stopped seat',
    });
  });

  test('the audit line is the one logLine writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-delegate-'));
    made.push(dir);
    const now = new Date('2026-10-06T12:00:00.000Z');
    logDelegated(dir, 'other/w1:p1', 'up', now);
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toBe('2026-10-06T12:00:00.000Z delegate [delegate] other/w1:p1 up\n');
  });
});
