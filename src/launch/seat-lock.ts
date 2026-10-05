import { randomBytes } from 'node:crypto';
import { accessSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One exclusive lock per session and seat, so `answer` and the launch that resumes the
 * same seat cannot both act. The lock is `<state dir>/seat-locks/<session>/<seat>`, and
 * it holds an owner token, `<pid> <nonce>`.
 *
 * Acquisition is one atomic step whose content is already complete: the token is written
 * into a private temp file, then `link`ed onto the lock path. `link` either creates the
 * name or fails with `EEXIST`, so any process that can see the lock path reads the whole
 * token — there is no instant at which the lock exists and is empty, which is the window
 * the open-then-write lock had (a second taker read the empty file as pid 0, renamed it
 * away and took a fresh one, and the first taker then wrote into its unlinked inode and
 * proceeded). A lock whose token cannot be read or parsed is **held**: it is never renamed
 * or removed, so a corrupt lock refuses callers instead of admitting two.
 *
 * A stale lock — a token whose pid is dead — is taken over by the taker that wins a
 * second, exclusive `link` on `<path>.steal`. The claim serialises the takeover's
 * read-check-unlink-publish sequence: without it, two takers can both read the stale
 * token, the faster one removes it and publishes, and the slower one then removes the
 * fresh lock (its re-read is not atomic with its unlink) and publishes its own, leaving
 * two holders. Only the claim's holder may remove the lock path, and only when the token
 * still reads exactly the same as when it was judged stale; if another taker published in
 * the meantime, the claim holder leaves that lock alone and is refused. A claim left by a
 * crashed taker names a dead pid and the next taker drops it. Release compares the whole
 * token, so it can only remove a lock this process published.
 *
 * The steps are injectable so a test can stop a taker between any two of them and run
 * another taker in that instant, deterministically.
 */
export function seatLockPath(dir: string, session: string, seat: string): string {
  return join(dir, 'seat-locks', session, seat);
}

export type LockSteps = {
  /** Creates the session's lock folder. */
  prepare(folder: string): void;
  /** Writes `token` in full to a private temp path beside `target` and returns that path. */
  stage(target: string, token: string): string;
  /** Publishes `from` at `to` in one step; throws `EEXIST` when `to` exists. */
  publish(from: string, to: string): void;
  /** The text at `path`, or null when it is absent or cannot be read. */
  read(path: string): string | null;
  /** Whether `path` exists, even when it cannot be read. */
  exists(path: string): boolean;
  /** Best-effort removal. */
  drop(path: string): void;
  /** Whether a pid names a live process; `EPERM` counts as live. */
  alive(pid: number): boolean;
  pid(): number;
  nonce(): string;
};

export const lockSteps: LockSteps = {
  prepare: (folder) => {
    mkdirSync(folder, { recursive: true });
  },
  stage: (target, token) => {
    const path = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(path, `${token}\n`, { flag: 'wx' });
    return path;
  },
  publish: (from, to) => {
    linkSync(from, to);
  },
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: (path) => {
    try {
      accessSync(path);
      return true;
    } catch {
      return false;
    }
  },
  drop: (path) => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or never there.
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  pid: () => process.pid,
  nonce: () => randomBytes(6).toString('hex'),
};

type Owner = { pid: number; token: string };

/** The owner a lock's text names, or null for anything that is not one complete token. */
function parseToken(text: string | null): Owner | null {
  if (text === null) return null;
  const token = text.trim();
  const match = /^([1-9]\d*) ([0-9a-f]+)$/.exec(token);
  if (!match) return null;
  return { pid: Number(match[1]), token };
}

export type SeatLock = { release(): void } | { held: number };

/**
 * Takes the lock, or reports the live pid that holds it. A dead holder's lock is taken
 * over; a lock that cannot be read or parsed is held, and its holder is unknown (-1).
 */
export function acquireSeatLock(dir: string, session: string, seat: string, overrides?: Partial<LockSteps>): SeatLock {
  const steps: LockSteps = { ...lockSteps, ...overrides };
  const path = seatLockPath(dir, session, seat);
  const claimPath = `${path}.steal`;
  steps.prepare(join(dir, 'seat-locks', session));
  const token = `${steps.pid()} ${steps.nonce()}`;
  const mine = steps.stage(path, token);

  const done = (): SeatLock => ({
    release: () => {
      if (parseToken(steps.read(path))?.token === token) steps.drop(path);
      steps.drop(mine);
    },
  });
  const held = (): SeatLock => {
    steps.drop(mine);
    return { held: -1 };
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      steps.publish(mine, path);
      steps.drop(mine);
      return done();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const text = steps.read(path);
    if (text === null) {
      // Unreadable is held, never stale; gone means the name is free again.
      if (steps.exists(path)) return held();
      continue;
    }
    const owner = parseToken(text);
    if (!owner) return held();
    if (steps.alive(owner.pid)) {
      steps.drop(mine);
      return { held: owner.pid };
    }
    if (!claim(claimPath, token, steps)) return held();
    try {
      const now = steps.read(path);
      if (now === null ? steps.exists(path) : now.trim() !== owner.token) {
        // The lock changed under the claim: someone else owns it now. Leave it.
        return held();
      }
      steps.drop(path);
      try {
        steps.publish(mine, path);
        steps.drop(mine);
        return done();
      } catch {
        // Another taker published in the free window; it owns the lock.
        return held();
      }
    } finally {
      steps.drop(claimPath);
    }
  }
  return held();
}

/** Wins the right to take over one stale lock, or loses to a taker that already has it. */
function claim(claimPath: string, token: string, steps: LockSteps): boolean {
  const text = steps.read(claimPath);
  if (text !== null) {
    const owner = parseToken(text);
    if (owner && steps.alive(owner.pid)) return false;
    steps.drop(claimPath);
  } else if (steps.exists(claimPath)) {
    steps.drop(claimPath);
  }
  const mine = steps.stage(claimPath, token);
  try {
    steps.publish(mine, claimPath);
    return true;
  } catch {
    return false;
  } finally {
    steps.drop(mine);
  }
}
