import { reportedLiveAgent } from './agent.ts';
import { profileFor } from '../profiles/index.ts';
import { classifyComposer, readBox, readFold, readFoldMark, readScreen, type Box, type Fold } from '../watch/screen.ts';

export interface Delivery {
  screen(): string | undefined;
  status(): string | null;
  type(text: string): boolean;
  enter(): boolean;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(): string[] | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  beforeInput?(action: 'type' | 'enter'): boolean;
}

/** The rows a composer shows for `text` at `width` columns: a hard wrap, a line longer than the
 *  width split into width-sized chunks, no word wrapping. The fold's tail and count are checked
 *  against this model; the fixtures README names the same one. */
function rowsOf(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) { rows.push(''); continue; }
    for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width));
  }
  return rows;
}

/** Whether the folded box is exactly `text` at the width the box reports: its visible tail rows
 *  are the text's last rows, and its hidden-row count closes the gap. Anything else is not the
 *  typed text and gets no Enter. */
function holdsText(text: string, fold: Fold): boolean {
  if (fold.width <= 0 || fold.rows.length === 0) return false;
  const all = rowsOf(text, fold.width);
  if (fold.rows.length >= all.length) return false;
  if (fold.count !== all.length - fold.rows.length) return false;
  const tail = all.slice(-fold.rows.length);
  return fold.rows.every((row, i) => row.trimEnd() === (tail[i] ?? '').trimEnd());
}

/** The whitespace a row break may stand for: the pane replaces it by the break, or adds the
 *  continuation row's indentation where the text has none. */
const BREAK = /[ \t\n\r]/;

/** Where the text's next row starts after `pos`, or null when `row` is not the text's row there.
 *  A row that is the text's at that very position is always read as such — that normalises
 *  nothing. A `word` boundary additionally skips the whitespace run the pane broke at before the
 *  row; a `hard` one reads the text's next characters as the row carries them; a composer with no
 *  rule (`null`) reads either way, since no capture showed how that one wraps. Every character
 *  inside a row must match the text as it is: only the row break may stand for whitespace. */
function continues(text: string, pos: number, row: string, kind: 'word' | 'hard' | null): number | null {
  if (text.startsWith(row, pos)) return pos + row.length;
  if (kind === 'hard') return null;
  let at = pos;
  while (at < text.length && BREAK.test(text[at] ?? '')) at++;
  return at > pos && text.startsWith(row, at) ? at + row.length : null;
}

/** Where a blank row sits in the typed text: the pane draws an empty row only for a blank line
 *  the text itself has. The line's own content — nothing a box row shows, so only spaces and
 *  tabs, which a pane need not paint — is consumed; an interior blank line ends at the next
 *  newline, a blank last line ends with the text. A blank row anywhere else is not the text's
 *  own and is refused, and a blank line the box does not show a row for is refused after the
 *  last row (the trailing-newline check in `holdsBox`). */
function blankLine(text: string, pos: number): number | null {
  if (text[pos] !== '\n') return null;
  let at = pos + 1;
  while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
  return at === text.length || text[at] === '\n' ? at : null;
}

/** Whether the box shows exactly `text`: the first line after the prompt and every continuation
 *  row at the box's own column — no more rows, no fewer, none changed. A continuation row that
 *  does not start at that column is not the text's own row and the box is not trusted. Only the
 *  whitespace a row break itself may stand for is normalised — the run a word break was made at,
 *  or a blank line the text itself has — and inside a row every character must match, runs of
 *  spaces included. A box that is not the text waits and is refused at the deadline, never
 *  entered on trust. */
function holdsBox(text: string, box: Box): boolean {
  const pad = ' '.repeat(box.indent);
  const rows: string[] = [];
  for (const row of box.rows) {
    if (row === '') { rows.push(''); continue; }
    if (!row.startsWith(pad)) return false;
    rows.push(row.slice(pad.length));
  }
  const kind = box.wrap?.kind ?? null;
  const visual = [box.first, ...rows];
  let at = 0;
  for (let i = 0; i < visual.length; i++) {
    const row = visual[i] ?? '';
    if (i === 0) {
      if (!text.startsWith(row)) return false;
      at = row.length;
      continue;
    }
    if (row === '') {
      const next = blankLine(text, at);
      if (next === null) return false;
      at = next;
      continue;
    }
    const next = continues(text, at, row, kind);
    if (next === null) return false;
    at = next;
  }
  // What is left after the box's last row. Trailing spaces and tabs are not observable in a
  // box — a pane may not paint the end of a row — so they are not required to match. A newline
  // is observable: it is the box's next row, and every row has been read above; one left over
  // is a row the box does not show, and the box is not the typed text.
  return /^[ \t]*$/.test(text.slice(at));
}

/** What the box holds right now: `ready` to submit, still rendering (`wait`), or a state that is
 *  never the typed text (`no`). A folded box — and one showing a fold marker whatever its count —
 *  is ready only when its tail and hidden-row count are the ones the text renders to at the width
 *  the box reports. An ordinary box is ready only when its rows read back as exactly the text
 *  typed; anything else waits, and a wait that outlives the deadline is a refusal, not an Enter. */
function boxState(cli: string, text: string, screen: string | undefined): 'ready' | 'wait' | 'no' {
  const kind = readScreen(cli, screen).kind;
  const fold = readFold(cli, screen);
  if (fold || readFoldMark(cli, screen)) {
    if (kind !== 'unsent' && kind !== 'unknown') return 'no';
    return fold !== null && holdsText(text, fold) ? 'ready' : 'wait';
  }
  if (kind === 'unsent') {
    const box = readBox(cli, screen);
    return box !== null && holdsBox(text, box) ? 'ready' : 'wait';
  }
  return kind === 'idle' ? 'wait' : 'no';
}

/** Whether the pane's box holds exactly `text` right now: an unsent composer, no fold marker, and
 *  rows that read back as the text. The one check the watch's nudge and the exit typing share
 *  with delivery — false for anything not observed, never `true` on trust. */
export function boxHoldsText(cli: string, text: string, screen: string | undefined): boolean {
  if (readFoldMark(cli, screen)) return false;
  if (readScreen(cli, screen).kind !== 'unsent') return false;
  const box = readBox(cli, screen);
  return box !== null && holdsBox(text, box);
}

/** A first message is accepted only after working is observed with the composer empty again. */
export async function deliverRules(cli: string, text: string, seconds: number, io: Delivery): Promise<boolean | 'no-agent'> {
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(io.foreground(), names);
  const free = () => ['idle', 'done'].includes(io.status() ?? '');
  if (!live()) return 'no-agent';
  if (!free() || readScreen(cli, io.screen()).kind !== 'idle' || (io.beforeInput && !io.beforeInput('type')) || !io.type(text)) return false;
  const deadline = io.now() + seconds * 1000;
  // Terminal rendering can lag send-text. Never press Enter until the box is verified to hold the
  // text: an ordinary box reads `unsent`, and a box that folded the paste counts only when the
  // tail and hidden-row count it shows are the ones the typed text renders to.
  for (;;) {
    if (!free()) return false;
    const state = boxState(cli, text, io.screen());
    if (state === 'ready') break;
    if (state === 'no' || io.now() >= deadline) return false;
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return false;
  }
  // Re-read immediately before Enter. The agent is asked again: it may have exited since the
  // paste, and a dialog that appeared gets no key; a folded box that no longer matches the text
  // gets none either.
  if (!live()) return 'no-agent';
  if (!free() || boxState(cli, text, io.screen()) !== 'ready' || (io.beforeInput && !io.beforeInput('enter')) || !io.enter()) return false;
  for (;;) {
    const status = io.status();
    const screen = io.screen();
    const composer = screen === undefined ? { kind: 'unknown' as const } : classifyComposer(cli, screen.split('\n'));
    if (status === 'working' && composer.kind === 'idle') return true;
    const kind = readScreen(cli, io.screen()).kind;
    if (kind === 'trust' || kind === 'permission' || kind === 'question' || io.now() >= deadline) return false;
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return false;
  }
}
