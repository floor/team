import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSeatLock, lockSteps, seatLockPath, type LockSteps, type SeatLock } from '../../src/launch/seat-lock.ts';

const DEAD = 2147483646;

function place(): { dir: string; path: string; claim: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-lock-')));
  const path = seatLockPath(dir, 'acme', 'lead');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  return { dir, path, claim: `${path}.steal` };
}

const token = (path: string): string => readFileSync(path, 'utf8').trim();
const own = (lock: SeatLock): lock is { release(): void } => 'release' in lock;

describe('the seat lock', () => {
  test('a dead holder is taken over, and a live one is left alone', () => {
    const { dir, path } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    const taken = acquireSeatLock(dir, 'acme', 'lead');
    expect(own(taken)).toBe(true);
    expect(token(path)).toMatch(new RegExp(`^${process.pid} [0-9a-f]+$`));
    if (own(taken)) taken.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();

    writeFileSync(path, `${process.pid} deadbeef\n`);
    const held = acquireSeatLock(dir, 'acme', 'lead');
    expect(held).toEqual({ held: process.pid });
    expect(token(path)).toBe(`${process.pid} deadbeef`);
  });

  test('the reviewer interleaving has no instant to land in: a taker stops before its one atomic step', () => {
    // The old lock published an empty file and wrote the pid after; a second taker read
    // that empty file as pid 0, renamed it away and took a fresh lock, and the first
    // taker then wrote into its unlinked inode and proceeded. Here the second taker is
    // run in the instant after the first has staged its token and before its `link`,
    // which is the only window the link-based lock has.
    const { dir, path } = place();
    let b: SeatLock | undefined;
    let stopped = false;
    const steps: Partial<LockSteps> = {
      nonce: () => 'aaaaaaaaaaaa',
      publish: (from, to) => {
        if (to === path && !stopped) {
          stopped = true;
          b = acquireSeatLock(dir, 'acme', 'lead');
        }
        lockSteps.publish(from, to);
      },
    };
    const a = acquireSeatLock(dir, 'acme', 'lead', steps);
    expect(b).toBeDefined();
    expect(own(b as SeatLock)).toBe(true);
    expect('held' in a).toBe(true);
    // The taker that paused before publishing never saw, and never left, an empty lock:
    // the name only ever came into being with a complete token.
    expect(token(path)).toMatch(/^[1-9]\d* [0-9a-f]+$/);
    expect(readdirSync(join(dir, 'seat-locks', 'acme'))).toEqual(['lead']);
    if (own(b as SeatLock)) (b as { release(): void }).release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a takeover claim keeps a second taker from removing the lock its holder publishes', () => {
    // Without the claim: both takers read the stale token, the first removes it and
    // publishes, the second then removes that fresh lock and publishes its own.
    const { dir, path } = place();
    const stale = `${DEAD} deadbeef\n`;
    writeFileSync(path, stale);
    let b: SeatLock | undefined;
    let ran = false;
    const steps: Partial<LockSteps> = {
      drop: (target) => {
        if (target === path && !ran) {
          ran = true;
          b = acquireSeatLock(dir, 'acme', 'lead');
        }
        lockSteps.drop(target);
      },
    };
    const a = acquireSeatLock(dir, 'acme', 'lead', steps);
    expect(own(a)).toBe(true);
    expect(b).toBeDefined();
    expect('held' in (b as SeatLock)).toBe(true);
    // B was refused at the claim, so the lock A published is A's own and still there.
    expect(token(path)).toMatch(new RegExp(`^${process.pid} [0-9a-f]+$`));
    if (own(a)) a.release();
  });

  test('a taker that loses the re-link after removing a stale lock is refused, not a second holder', () => {
    const { dir, path } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    let c: SeatLock | undefined;
    let ran = false;
    const steps: Partial<LockSteps> = {
      drop: (target) => {
        lockSteps.drop(target);
        if (target === path && !ran) {
          ran = true;
          c = acquireSeatLock(dir, 'acme', 'lead');
        }
      },
    };
    const a = acquireSeatLock(dir, 'acme', 'lead', steps);
    expect('held' in a).toBe(true);
    expect(c).toBeDefined();
    expect(own(c as SeatLock)).toBe(true);
    expect(token(path)).toMatch(new RegExp(`^${process.pid} [0-9a-f]+$`));
    if (own(c as SeatLock)) (c as { release(): void }).release();
  });

  test('a lock that cannot be read or parsed is held, never stale', () => {
    const { dir, path } = place();
    writeFileSync(path, '');
    expect(acquireSeatLock(dir, 'acme', 'lead')).toEqual({ held: -1 });
    expect(readFileSync(path, 'utf8')).toBe('');

    writeFileSync(path, 'nonsense\n');
    expect(acquireSeatLock(dir, 'acme', 'lead')).toEqual({ held: -1 });
    expect(readFileSync(path, 'utf8')).toBe('nonsense\n');

    // A directory cannot be read as a token and cannot be replaced by `link`.
    lockSteps.drop(path);
    mkdirSync(path);
    expect(acquireSeatLock(dir, 'acme', 'lead')).toEqual({ held: -1 });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(join(dir, 'seat-locks', 'acme'))).toEqual(['lead']);
  });

  test('release removes only a lock that still carries this taker\'s token', () => {
    const { dir, path } = place();
    const lock = acquireSeatLock(dir, 'acme', 'lead');
    expect(own(lock)).toBe(true);
    if (!own(lock)) return;
    const mine = token(path);
    writeFileSync(path, `${DEAD} other\n`);
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe(`${DEAD} other\n`);
    writeFileSync(path, `${mine}\n`);
    if (own(lock)) lock.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a claim left by a dead taker blocks nobody', () => {
    const { dir, path, claim } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    writeFileSync(claim, `${DEAD} deadbeef\n`);
    const lock = acquireSeatLock(dir, 'acme', 'lead');
    expect(own(lock)).toBe(true);
    expect(token(path)).toMatch(new RegExp(`^${process.pid} [0-9a-f]+$`));
    if (own(lock)) lock.release();
  });

  test('a claim held by a live taker refuses the takeover and leaves the stale lock', () => {
    const { dir, path, claim } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    writeFileSync(claim, `${process.pid} cafefeed\n`);
    expect(acquireSeatLock(dir, 'acme', 'lead')).toEqual({ held: -1 });
    expect(readFileSync(path, 'utf8')).toBe(`${DEAD} deadbeef\n`);
    expect(readFileSync(claim, 'utf8')).toBe(`${process.pid} cafefeed\n`);
  });
});
