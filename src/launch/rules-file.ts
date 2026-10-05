import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, mkdirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { storePath, type Standing } from '../store/store.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { SEAT_NAME } from '../file/sections/seats.ts';
import { worktreeTeamInForceOf } from '../approve/approval.ts';
import { profileFor } from '../profiles/index.ts';
import { rulesOf } from './rules.ts';

/** `O_NOFOLLOW` is POSIX, not plain JS: a platform without it gets 0, and the `lstat` checks
 *  above every open still refuse a link. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The one line a seat's rules travel in, once they are in a file: `Read <path> (sha256 <hash>):
 *  your standing rules for this session; reply ready and wait for your brief.` The read-back can
 *  prove a path only of these characters — anything else and nothing is typed, fail closed. */
const TYPEABLE = /^[A-Za-z0-9._/@+-]+$/;

/** Whether a path can be typed and read back provably: no whitespace, no character outside
 *  letters, digits and `. _ / @ + -`. A path that fails is never quoted or escaped. */
export function typeablePath(path: string): boolean {
  return TYPEABLE.test(path);
}

/** Whether a seat name can become a file name: it must pass the team file's own seat-name rule
 *  (the same expression the parser holds, not a second one — so a leading `.` , a `/`, a `..`,
 *  a space or any other character the file refuses is refused here too), and the file name it
 *  makes must stay within 255 bytes. */
export function typeableSeat(seat: string): boolean {
  return SEAT_NAME.test(seat) && Buffer.byteLength(`${seat}.md`) <= 255;
}

/** The file a seat's rules are written to: `<project state folder>/rules/<seat name>.md`, the
 *  folder the approval store already uses for this project, never inside a worktree, the lobby
 *  or the project. A seat name the team file's own rule refuses gets no path at all — null, so
 *  nothing downstream can normalise it somewhere else. */
export function rulesFilePath(project: string, root: string, home: string, seat: string): string | null {
  return typeableSeat(seat) ? join(storePath(project, root, home), 'rules', `${seat}.md`) : null;
}

/** The line typed into the seat's pane: the file's absolute path and the first 12 hex digits of
 *  its SHA-256, so the seat — and the read-back — can tell exactly which text is meant. */
export function rulesLine(path: string, hash12: string): string {
  return `Read ${path} (sha256 ${hash12}): your standing rules for this session; reply ready and wait for your brief.`;
}

/** The first 12 hex digits of a text's SHA-256. */
export function rulesFileHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** What one path holds, read with `lstat` so a link is a link and never followed: `missing` when
 *  nothing is there, else the kind with its mode and owner. One reading shared by the writer, the
 *  checks and the before-Enter look — there is no second way to look at these files. */
export type Held =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'fifo' }
  | { kind: 'folder'; mode: number; uid: number }
  | { kind: 'file'; mode: number; uid: number }
  | { kind: 'other' };

/** What `path` holds right now, without following anything. */
export function heldAt(path: string): Held {
  let held;
  try {
    held = lstatSync(path);
  } catch {
    return { kind: 'missing' };
  }
  if (held.isSymbolicLink()) return { kind: 'link' };
  if (held.isFIFO()) return { kind: 'fifo' };
  if (held.isDirectory()) return { kind: 'folder', mode: held.mode & 0o777, uid: held.uid };
  if (held.isFile()) return { kind: 'file', mode: held.mode & 0o777, uid: held.uid };
  return { kind: 'other' };
}

/** Reads a file without following a link: the path must already have been seen as a regular file
 *  (`heldAt`), and the open itself carries `O_NOFOLLOW` so what is read is that same file. Null
 *  on any fault — the caller refuses, never guesses. */
function readHeld(path: string): string | null {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const parts: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const took = readSync(fd, buffer, 0, buffer.length, null);
      if (took === 0) break;
      parts.push(Buffer.from(buffer.subarray(0, took)));
    }
    return Buffer.concat(parts).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What a folder of the write's ladder must be: a real directory of this user's. `mode` is the
 *  exact mode required of the folders `team` itself makes (`rules/` and the project state
 *  folder); the state root only has to be a directory of this user's, whatever mode the user
 *  keeps it in. The finding is for the report, so the owner knows what is there. */
function folderFinding(held: Held, mode: number | null): string | null {
  if (held.kind === 'missing') return null; // made below, one level, explicit mode
  if (held.kind === 'link') return 'a symbolic link';
  if (held.kind !== 'folder') return 'not a directory';
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's folder";
  if (mode !== null && held.mode !== mode) return `mode 0${held.mode.toString(8)}, not 0${mode.toString(8)}`;
  return null;
}

/** What the final name must hold when it holds anything: a regular file, this user's, `0600`.
 *  Anything else — a link, a FIFO, a directory, a wider mode, another owner — is named for the
 *  report and never replaced. */
function placeFinding(held: Held): string | null {
  if (held.kind === 'missing') return null;
  if (held.kind === 'link') return 'a symbolic link';
  if (held.kind === 'fifo') return 'a FIFO';
  if (held.kind === 'folder') return 'a directory';
  if (held.kind === 'other') return 'not a regular file';
  if (held.mode !== 0o600) return `mode 0${held.mode.toString(8)}, not 0600`;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return "another user's file";
  return null;
}

/** What writing the rules file came to. `folder` is a folder of the ladder from the per-user
 *  state root down to `rules/` being something other than a real directory of this user's at the
 *  required mode; `place` is the final name holding anything other than this user's `0600`
 *  regular file; `changed` is a write that landed but did not read back as the line's hash;
 *  `not-written` is every other fault. In each refusal nothing was typed. */
export type RulesFileWrite =
  | { ok: true }
  | { ok: false; why: 'not-written' }
  | { ok: false; why: 'changed' }
  | { ok: false; why: 'folder'; what: string }
  | { ok: false; why: 'place'; what: string };

/** Writes the seat's rules to `path` as the approval's equal: nothing is followed, nothing the
 *  writer did not make is replaced. Every folder from `team`'s per-user state root down to
 *  `rules/` is checked with `lstat` — a real directory of this user's, not a link, `rules/` and
 *  the project folder exactly `0700` (a looser folder is refused, never `chmod`'d) — and a
 *  missing level is made one level at a time with an explicit mode, never by a recursive create
 *  that could walk through a link. The final name, if it holds anything, must be this user's
 *  `0600` regular file or the write refuses and says what is there. The text lands through a
 *  temporary of an unpredictable name opened `O_CREAT | O_EXCL | O_NOFOLLOW` at mode `0600` — an
 *  open that fails writes nothing and leaves nothing, and the temporary is removed on every
 *  failure path — and after the rename the file is read back without following a link and its
 *  SHA-256 compared with `hash12`, the hash the line carries: a mismatch refuses, nothing typed. */
export function writeRulesFile(path: string, text: string, hash12: string, random: () => string = () => randomBytes(10).toString('hex')): RulesFileWrite {
  // The ladder, top down: team's per-user state root (`<home>/.config/team`), the project state
  // folder, `rules/`. The mode is required only of the two `team` itself makes.
  const ladder: Array<{ at: string; mode: number | null }> = [
    { at: dirname(dirname(dirname(path))), mode: null },
    { at: dirname(dirname(path)), mode: 0o700 },
    { at: dirname(path), mode: 0o700 },
  ];
  for (const level of ladder) {
    const held = heldAt(level.at);
    if (held.kind === 'missing') {
      try {
        mkdirSync(level.at, { mode: 0o700 });
      } catch {
        return { ok: false, why: 'not-written' };
      }
    } else {
      const finding = folderFinding(held, level.mode);
      if (finding !== null) return { ok: false, why: 'folder', what: finding };
    }
  }
  const place = placeFinding(heldAt(path));
  if (place !== null) return { ok: false, why: 'place', what: place };
  const temporary = join(dirname(path), `${basename(path)}.${random()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch {
    // The name is taken — or worse, is a link: exclusive no-follow refused it, nothing was
    // written, and what is there is not ours to remove.
    return { ok: false, why: 'not-written' };
  }
  try {
    const buffer = Buffer.from(text, 'utf8');
    for (let wrote = 0; wrote < buffer.length;) {
      wrote += writeSync(fd, buffer, wrote, buffer.length - wrote);
    }
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already took it, or the folder went: nothing more to clean.
    }
    return { ok: false, why: 'not-written' };
  }
  // Read back what landed, without following a link, and prove it is the text the line names.
  const held = heldAt(path);
  if (held.kind !== 'file') return { ok: false, why: 'changed' };
  const read = readHeld(path);
  if (read === null || rulesFileHash(read) !== hash12) return { ok: false, why: 'changed' };
  return { ok: true };
}

/** Whether the file at `path` still holds the text whose SHA-256 starts `hash12` — read the same
 *  no-follow way the writer reads it back: `lstat` says regular file, the open carries
 *  `O_NOFOLLOW`. The last look before Enter. */
export function rulesFileHolds(path: string, hash12: string): boolean {
  const held = heldAt(path);
  if (held.kind !== 'file' || held.mode !== 0o600) return false;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return false;
  const read = readHeld(path);
  return read !== null && rulesFileHash(read) === hash12;
}

/** Removes a seat's rules file — a temporary seat's, with the seat. The name is checked where
 *  the unlink happens, not only where the path was built: a corrupt state entry holding `..`
 *  or any name the team file's rule refuses must not turn a removal into an unlink somewhere
 *  else, so anything that is not `<state folder>/rules/<a name the file accepts>.md` is left
 *  entirely alone. A file that is not there, or a write that never landed, leaves nothing to
 *  complain about. */
export function removeRulesFile(path: string | null): void {
  if (path === null) return;
  if (basename(dirname(path)) !== 'rules') return;
  if (!typeableSeat(basename(path).replace(/\.md$/, ''))) return;
  try {
    unlinkSync(path);
  } catch {
    // Nothing to remove, or not ours to touch: the seat is gone either way.
  }
}

/** What `status` and `doctor` say of one seat's rules file, against the approved rules text.
 *  `what` is the finding without the seat's name; `ok` asks for nothing. A file that differs is
 *  never rewritten by a check. */
export type RulesFileCheck = { ok: true } | { ok: false; what: string };

/** Checks one seat's rules file with the writer's own reading of a path (`heldAt`, then the
 *  no-follow open): a regular file, mode `0600`, owned by this user, holding exactly the
 *  approved rules text for that seat. */
export function checkRulesFile(path: string, approvedText: string): RulesFileCheck {
  const held = heldAt(path);
  if (held.kind === 'missing') return { ok: false, what: 'its rules file is missing' };
  if (held.kind === 'link') return { ok: false, what: 'its rules file is a symbolic link' };
  if (held.kind !== 'file') return { ok: false, what: 'its rules file is not a regular file' };
  if (held.mode !== 0o600) {
    return { ok: false, what: `its rules file has mode 0${held.mode.toString(8)}, not 0600` };
  }
  if (process.getuid === undefined || held.uid !== process.getuid()) {
    return { ok: false, what: 'its rules file is not owned by this user' };
  }
  const text = readHeld(path);
  if (text === null) return { ok: false, what: 'its rules file cannot be read' };
  return text === approvedText ? { ok: true } : { ok: false, what: 'its rules file differs from the approved rules' };
}

/** One message-rules seat's delivery: the file its rules are written to, the text that goes in
 *  it, and the one line typed in its pane. The text is the **approved** one — taken from the copy
 *  of the team file the approval record stored, through the same accessor the worktree commands
 *  use (`worktreeTeamInForceOf`), seat looked up by name in that copy so its own signature lines
 *  are the approved ones too. `up` and `add` refuse a file that differs from the approval, so on
 *  a normal run both texts are equal; the invariant does not depend on that gate. A path that
 *  can't be typed safely is a refusal — before anything is written or typed. */
export function rulesDeliveryOf(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  root: string,
  home: string,
): { text: string; path: string; line: string } | { refusal: string } {
  if (profileFor(seat.cli)?.rulesOption != null) return { refusal: 'its rules travel as a launch option' };
  const path = rulesFilePath(team.project, root, home, seat.name);
  if (path === null || !typeablePath(path)) {
    return { refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -" };
  }
  const inForce = worktreeTeamInForceOf(standing, team);
  if (inForce === null) return { refusal: "the approved copy of the team file can't be read" };
  const held = inForce.team.seats.find((item) => item.name === seat.name);
  if (held === undefined) return { refusal: 'its rules are not in the approved copy of the team file' };
  const text = rulesOf(inForce.team, held);
  return { text, path, line: rulesLine(path, rulesFileHash(text)) };
}

/** A message seat's delivery in the plan: the file its rules go to and the line that points at
 *  it, or the refusal that stops the seat before anything is typed. An option seat has neither. */
export function seatDeliveryOf(standing: Standing, team: TeamFile, seat: Seat, root: string, home: string): { rulesFile?: { path: string; line: string }; rulesRefusal?: string } {
  if (profileFor(seat.cli)?.rulesOption != null) return {};
  const delivery = rulesDeliveryOf(standing, team, seat, root, home);
  if ('refusal' in delivery) return { rulesRefusal: delivery.refusal };
  return { rulesFile: { path: delivery.path, line: delivery.line } };
}
