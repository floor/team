import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLine } from '../src/log.ts';
import { LOCK_FILE, LOG_FILE, STATE_FILE, emptySession, readState, updateState, withLock, writeAtomic } from '../src/state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the state file', () => {
  test('a missing file is an empty state', () => {
    expect(readState(dir)).toEqual({ format: 1, sessions: {} });
  });

  test('is keyed by session, and written whole', () => {
    updateState(dir, (state) => {
      state.sessions.one = { ...emptySession(), seats: { a: { stage: 'ready' } } };
      state.sessions.two = emptySession();
    });
    const state = readState(dir);
    expect(Object.keys(state.sessions)).toEqual(['one', 'two']);
    expect(state.sessions.one?.seats.a?.stage).toBe('ready');
    expect(readdirSync(dir)).toEqual([STATE_FILE]);
  });

  test('a seat record from before the process identity loads as it is, and is written back without one', () => {
    // The field is additive: an old file — a seat with a pane and a workspace, no `launched` —
    // reads name by name, and a command that writes another field leaves it with no identity.
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({
        format: 1,
        sessions: { one: { seats: { a: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} } },
      }),
    );
    expect(readState(dir).sessions.one?.seats.a).toEqual({ stage: 'ready', pane: 'w1:p1', workspace: 'w1' });
    updateState(dir, (state) => {
      const seat = state.sessions.one?.seats.a;
      if (seat) seat.worked = true;
    });
    expect(readState(dir).sessions.one?.seats.a).toEqual({ stage: 'ready', pane: 'w1:p1', workspace: 'w1', worked: true });
  });

  test('a file that is not a state is an error, never replaced', () => {
    writeFileSync(join(dir, STATE_FILE), '{"format": 2}');
    expect(() => readState(dir)).toThrow(/not a team state of format 1/);
    expect(() => updateState(dir, () => {})).toThrow();
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe('{"format": 2}');
    writeFileSync(join(dir, STATE_FILE), '{half');
    expect(() => readState(dir)).toThrow(/not valid JSON/);
  });

  test('an atomic write leaves no temporary file', () => {
    writeAtomic(join(dir, 'x.json'), 'one');
    writeAtomic(join(dir, 'x.json'), 'two');
    expect(readFileSync(join(dir, 'x.json'), 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });
});

describe('the lock', () => {
  test('holds the pid while the work runs, and is gone after', () => {
    const seen = withLock(dir, () => readFileSync(join(dir, LOCK_FILE), 'utf8').trim());
    expect(seen).toBe(String(process.pid));
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  test('is released when the work throws', () => {
    expect(() => withLock(dir, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  test('a lock whose holder is alive is waited for, then refused', () => {
    // pid 1 is always alive and is never this process.
    writeFileSync(join(dir, LOCK_FILE), '1\n');
    expect(() => withLock(dir, () => 'ran', { waitMs: 120 })).toThrow(/another team command \(pid 1\) holds/);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe('1\n');
  });

  test('a lock whose holder is dead is taken over, and that is reported', () => {
    const dead = Bun.spawnSync(['sh', '-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(dir, LOCK_FILE), `${dead}\n`);
    const stale: number[] = [];
    expect(withLock(dir, () => 'ran', { onStale: (pid) => stale.push(pid) })).toBe('ran');
    expect(stale).toEqual([Number(dead)]);
  });
});

describe('the log', () => {
  test('one line per change: when, which command, who, what', () => {
    logLine(dir, 'init', 'owner', 'wrote the\nfile', new Date('2026-10-03T14:00:00Z'));
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('2026-10-03T14:00:00.000Z init [owner] wrote the file\n');
  });

  test('rotates at 1 MB and keeps three files', () => {
    const path = join(dir, LOG_FILE);
    for (let round = 1; round <= 4; round++) {
      writeFileSync(path, `${String(round).repeat(1_000_000)}\n`);
      logLine(dir, 'watch', 'watch', `round ${round}`);
    }
    expect(readdirSync(dir).sort()).toEqual([LOG_FILE, `${LOG_FILE}.1`, `${LOG_FILE}.2`]);
    expect(statSync(path).size).toBeLessThan(200);
    expect(readFileSync(`${path}.1`, 'utf8')[0]).toBe('4');
    expect(readFileSync(`${path}.2`, 'utf8')[0]).toBe('3');
  });
});
