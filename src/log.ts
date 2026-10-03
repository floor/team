import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_FILE } from './state.ts';

const MAX_BYTES = 1_000_000;
const KEPT = 3;

// One line per change: when, which command, called by whom, what changed. Classifications only,
// never the text of a screen. The log rotates at 1 MB and keeps three files.
export function logLine(dir: string, command: string, caller: string, what: string, now: Date = new Date()): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOG_FILE);
  if (existsSync(path) && statSync(path).size >= MAX_BYTES) rotate(path);
  appendFileSync(path, `${now.toISOString()} ${command} [${caller}] ${what.replace(/\s+/g, ' ')}\n`);
}

function rotate(path: string): void {
  const oldest = `${path}.${KEPT - 1}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = KEPT - 2; n >= 1; n--) {
    if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
  }
  renameSync(path, `${path}.1`);
}
