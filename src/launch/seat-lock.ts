import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One exclusive lock per session and seat, so `answer` and the launch that resumes
 * the same seat cannot both act. The file is `<state dir>/seat-locks/<session>/<seat>`
 * and holds the holder's pid. A crash leaves the file. The next taker whose pid is
 * dead renames it aside and drops it; a live pid is left alone and the caller is refused.
 */
export function seatLockPath(dir: string, session: string, seat: string): string {
  return join(dir, 'seat-locks', session, seat);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
    } catch {
      // The holder released it, or another taker already replaced it.
    }
    return false;
  }
  unlinkSync(aside);
  return true;
}

export type SeatLock = { release(): void } | { held: number };

/** Takes the lock, or reports the live pid that holds it. A dead holder's file is taken over. */
export function acquireSeatLock(dir: string, session: string, seat: string): SeatLock {
  const path = seatLockPath(dir, session, seat);
  mkdirSync(join(dir, 'seat-locks', session), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => { try { unlinkSync(path); } catch { /* already gone */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        continue;
      }
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return { held: holder };
      if (!takeOver(path, holder)) continue;
    }
  }
  return { held: -1 };
}
