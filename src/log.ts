import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { plainLine } from './launch/plain.ts';
import { LOG_FILE } from './state.ts';

const MAX_BYTES = 1_000_000;
const KEPT = 3;

// One line per change: when, which command, called by whom, what changed. Classifications only,
// never the text of a screen.
//
// The line is cleaned here, at the one sink every command logs through, with the same function
// the records' fields are cleaned with (`plainLine`): every caller's or reason's escape
// sequence, bidi override or other invisible format character is removed before it can reach
// the file, so every line of every command's log is clean by construction, whoever calls and
// whatever the text it was given — the terminals and the log agree by construction.
// For ordinary text nothing changes: the cleaning removes or folds characters, it never rewrites
// an ordinary word. A line feed, U+2028/U+2029 and any whitespace run fold to one space, exactly
// as they do in a record's field, so the log stays one `0a`-terminated line per change and holds
// the same words the record said.
//
// The log rotates at 1 MB and keeps three files.
export function logLine(dir: string, command: string, caller: string, what: string, now: Date = new Date()): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOG_FILE);
  if (existsSync(path) && statSync(path).size >= MAX_BYTES) rotate(path);
  const line = plainLine(`${command} [${caller}] ${what}`).replace(/\s+/g, ' ');
  appendFileSync(path, `${now.toISOString()} ${line}\n`);
}

function rotate(path: string): void {
  const oldest = `${path}.${KEPT - 1}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = KEPT - 2; n >= 1; n--) {
    if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
  }
  renameSync(path, `${path}.1`);
}
