import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What only exists while a team runs. It lives beside the team file, is keyed by session, and is
// written by team alone: every write holds the lock and goes through a temporary file.

export type SeatState = {
  stage: 'launched' | 'named' | 'ready';
  pane?: string;
  /** The herdr workspace, so a later command can close it without listing agents. */
  workspace?: string;
  cli_version?: string;
  rules?: 'option' | 'message' | 'undelivered';
  worked?: boolean;
  temporary?: { like: string; until: string; task?: string };
};

export type WorktreeState = {
  path: string;
  branch: string;
  own_commits?: boolean;
  seat?: string;
  setup: 'ok' | 'failed';
};

export type SessionState = {
  started?: { at: string; by: string };
  seats: Record<string, SeatState>;
  worktrees: Record<string, WorktreeState>;
  watch?: { pid: number; heartbeat: string };
  nudge?: { pending_since: string | null };
};

export type State = {
  format: 1;
  last_valid?: { read_at: string; file: string };
  sessions: Record<string, SessionState>;
};

export const STATE_FILE = 'team.state.json';
export const LOCK_FILE = 'team.lock';
export const LOG_FILE = 'team.log';

export function emptySession(): SessionState {
  return { seats: {}, worktrees: {} };
}

// The state in `dir` (the folder of the team file). A missing file is an empty state; a file
// that can't be read as a state is an error, never silently replaced.
export function readState(dir: string): State {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return { format: 1, sessions: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; move it aside and run the command again`);
  }
  const state = parsed as Partial<State> | null;
  if (!state || typeof state !== 'object' || state.format !== 1 || typeof state.sessions !== 'object' || !state.sessions) {
    throw new Error(`${path} is not a team state of format 1; move it aside and run the command again`);
  }
  for (const session of Object.values(state.sessions)) {
    session.seats ??= {};
    session.worktrees ??= {};
  }
  return state as State;
}

// Reads the state, lets `change` edit it, and writes it back, all under the lock.
export function updateState<T>(dir: string, change: (state: State) => T): T {
  return withLock(dir, () => {
    const state = readState(dir);
    const result = change(state);
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return result;
  });
}

export function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Removes a lock whose holder is dead. Two commands may see the same dead holder: the lock is
// moved aside first, which only one of them can do, and put back if it turns out to be a fresh
// one that another command took in between.
function takeOver(path: string, holder: number): boolean {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  const found = Number(readFileSync(aside, 'utf8').trim());
  if (found !== holder && Number.isInteger(found) && found > 0 && alive(found)) {
    try {
      renameSync(aside, path);
    } catch {}
    return false;
  }
  unlinkSync(aside);
  return true;
}

// One writer at a time. The lock file holds its holder's pid; a lock whose holder is dead is
// taken over, and `onStale` is told.
export function withLock<T>(dir: string, work: () => T, options: { waitMs?: number; onStale?: (pid: number) => void } = {}): T {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + (options.waitMs ?? 5000);
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        continue; // released between the two calls
      }
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        if (Date.now() > deadline) throw new Error(`another team command (pid ${holder}) holds ${path}; try again when it is done`);
        pause(50);
        continue;
      }
      // A dead holder, or a lock file too young to hold its pid yet.
      if (!Number.isInteger(holder) && Date.now() - statSync(path).mtimeMs < 1000) {
        pause(20);
        continue;
      }
      if (takeOver(path, holder)) options.onStale?.(holder);
    }
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}
