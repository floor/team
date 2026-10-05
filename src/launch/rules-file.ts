import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { storePath } from '../store/store.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { profileFor } from '../profiles/index.ts';
import { rulesOf } from './rules.ts';

/** The one line a seat's rules travel in, once they are in a file: `Read <path> (sha256 <hash>):
 *  your standing rules for this session; reply ready and wait for your brief.` The read-back can
 *  prove a path only of these characters — anything else and nothing is typed, fail closed. */
const TYPEABLE = /^[A-Za-z0-9._/@+-]+$/;

/** Whether a path can be typed and read back provably: no whitespace, no character outside
 *  letters, digits and `. _ / @ + -`. A path that fails is never quoted or escaped. */
export function typeablePath(path: string): boolean {
  return TYPEABLE.test(path);
}

/** The file a seat's rules are written to: `<project state folder>/rules/<seat name>.md`, the
 *  folder the approval store already uses for this project, never inside a worktree, the lobby
 *  or the project. */
export function rulesFilePath(project: string, root: string, home: string, seat: string): string {
  return join(storePath(project, root, home), 'rules', `${seat}.md`);
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

/** What writing the rules file came to. `symlink` is the target or the `rules` folder itself
 *  being a symbolic link: the file is never written through or replaced then. */
export type RulesFileWrite = { ok: true } | { ok: false; why: 'symlink' | 'not-written' };

/** Writes the seat's rules to `path`, atomically: a temporary file next to it, then a rename, so
 *  a reader never sees half a file. The folder is made `0700` and the file is `0600`, both
 *  owner-only whatever the umask leaves in. A symbolic link at the target or at the `rules`
 *  folder is refused: nothing is written, nothing follows the link. */
export function writeRulesFile(path: string, text: string): RulesFileWrite {
  try {
    const folder = dirname(path);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const held = lstatSync(folder);
    if (held.isSymbolicLink() || !held.isDirectory()) return { ok: false, why: 'symlink' };
    chmodSync(folder, 0o700);
    let at = null;
    try {
      at = lstatSync(path);
    } catch {
      // No file there yet: the plain case.
    }
    if (at !== null && at.isSymbolicLink()) return { ok: false, why: 'symlink' };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
    return { ok: true };
  } catch {
    return { ok: false, why: 'not-written' };
  }
}

/** Removes a seat's rules file — a temporary seat's, with the seat. A file that is not there,
 *  or a write that never landed, leaves nothing to complain about. */
export function removeRulesFile(path: string): void {
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

/** Checks one seat's rules file: a regular file, mode `0600`, owned by this user, holding
 *  exactly the approved rules text for that seat. */
export function checkRulesFile(path: string, approvedText: string): RulesFileCheck {
  let held;
  try {
    held = lstatSync(path);
  } catch {
    return { ok: false, what: 'its rules file is missing' };
  }
  if (held.isSymbolicLink()) return { ok: false, what: 'its rules file is a symbolic link' };
  if (!held.isFile()) return { ok: false, what: 'its rules file is not a regular file' };
  if ((held.mode & 0o777) !== 0o600) {
    return { ok: false, what: `its rules file has mode 0${(held.mode & 0o777).toString(8)}, not 0600` };
  }
  if (process.getuid === undefined || held.uid !== process.getuid()) {
    return { ok: false, what: 'its rules file is not owned by this user' };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, what: 'its rules file cannot be read' };
  }
  return text === approvedText ? { ok: true } : { ok: false, what: 'its rules file differs from the approved rules' };
}

/** One message-rules seat's delivery: the file its rules are written to, the text that goes in
 *  it, and the one line typed in its pane. A path that can't be typed safely is a refusal —
 *  before anything is written or typed. */
export function rulesDeliveryOf(
  team: TeamFile,
  seat: Seat,
  root: string,
  home: string,
): { text: string; path: string; line: string } | { refusal: string } {
  const profile = profileFor(seat.cli);
  if (profile !== null && profile.rulesOption !== null) return { refusal: 'its rules travel as a launch option' };
  const text = rulesOf(team, seat);
  const path = rulesFilePath(team.project, root, home, seat.name);
  if (!typeablePath(path)) {
    return { refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -" };
  }
  return { text, path, line: rulesLine(path, rulesFileHash(text)) };
}

/** A message seat's delivery in the plan: the file its rules go to and the line that points at
 *  it, or the refusal that stops the seat before anything is typed. An option seat has neither. */
export function seatDeliveryOf(team: TeamFile, seat: Seat, root: string, home: string): { rulesFile?: { path: string; line: string }; rulesRefusal?: string } {
  if (profileFor(seat.cli)?.rulesOption != null) return {};
  const delivery = rulesDeliveryOf(team, seat, root, home);
  if ('refusal' in delivery) return { rulesRefusal: delivery.refusal };
  return { rulesFile: { path: delivery.path, line: delivery.line } };
}
