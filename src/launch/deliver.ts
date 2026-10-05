import { reportedLiveAgent } from './agent.ts';
import { profileFor } from '../profiles/index.ts';
import {
  classifyComposer, readBox, readFold, readFoldMark, readScreen, screenData, type Box, type Fold, type Screen,
} from '../watch/screen.ts';

/** The pane's own size in cells, as herdr reports it. */
export type PaneSize = { width: number; height: number };

/** Why a delivery stopped. Each one is a reading the owner can act on.
 *  - `line`: a line of the message is taller than any part's box draws; nothing was typed.
 *  - `screen`: the screen was not the idle prompt; nothing was typed.
 *  - `leftover`: the box already held text that does not read back as the message; nothing typed.
 *  - `typing`: the pane took no text; nothing was typed.
 *  - `read-back`: text was typed and never read back as the message's own rows.
 *  - `ack`: a part was submitted and the seat did not come back to its idle prompt. */
export type Stop = 'line' | 'screen' | 'leftover' | 'typing' | 'read-back' | 'ack';

/** Where a delivery stopped, for the report. `kind` is what the screen read at the stop; `rows`
 *  is the rows the box drew, `expected` the rows the typed text draws to (zero when either is
 *  not readable); `row` is the first row that did not read back as the text's own, kept out of
 *  the log and printed to the terminal alone; `part`/`parts` say which part stopped, when the
 *  message went in parts, and `sent` how many parts were submitted before it. */
export type Refusal = {
  stop: Stop;
  typed: boolean;
  sent: number;
  kind: Screen['kind'];
  rows: number;
  expected: number;
  row: string | null;
  line: number | null;
  part: number | null;
  parts: number;
};

export interface Delivery {
  screen(): string | undefined;
  status(): string | null;
  type(text: string): boolean;
  enter(): boolean;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(): string[] | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The pane's own size in cells, or null when it can't be read. A delivery whose pane has no
   *  readable size pastes the whole message, as it always has; with one, a message taller than
   *  its box draws is delivered in parts. */
  size?(): PaneSize | null;
  /** Why a delivery stopped, when the caller wants the detail for its report. */
  report?(why: Refusal): void;
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
 *  last row (the `short` arm of `readsBack`). */
function blankLine(text: string, pos: number): number | null {
  if (text[pos] !== '\n') return null;
  let at = pos + 1;
  while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
  return at === text.length || text[at] === '\n' ? at : null;
}

/** How the box reads back against `text`: `row` is the first row drawn that is not the text's
 *  own (an empty string for a blank row the text does not have there, the drawn row otherwise),
 *  and `short` says the text has a row after the box's last one. Both null/false is an exact
 *  read. The comparison is the one `holdsBox` has always made: the first line after the prompt
 *  and every continuation row at the box's own column — no more rows, no fewer, none changed. A
 *  continuation row that does not start at that column is not the text's own row. Only the
 *  whitespace a row break itself may stand for is normalised — the run a word break was made at,
 *  or a blank line the text itself has — and inside a row every character must match, runs of
 *  spaces included. Trailing spaces and tabs after the text's last row are not observable in a
 *  box — a pane may not paint the end of a row — so they are not required to match. */
function readsBack(text: string, box: Box): { row: string | null; short: boolean } {
  const pad = ' '.repeat(box.indent);
  const rows: string[] = [];
  for (const row of box.rows) {
    if (row === '') { rows.push(''); continue; }
    if (!row.startsWith(pad)) return { row, short: false };
    rows.push(row.slice(pad.length));
  }
  const kind = box.wrap?.kind ?? null;
  const visual = [box.first, ...rows];
  let at = 0;
  for (let i = 0; i < visual.length; i++) {
    const row = visual[i] ?? '';
    if (i === 0) {
      if (!text.startsWith(row)) return { row, short: false };
      at = row.length;
      continue;
    }
    if (row === '') {
      const next = blankLine(text, at);
      if (next === null) return { row, short: false };
      at = next;
      continue;
    }
    const next = continues(text, at, row, kind);
    if (next === null) return { row, short: false };
    at = next;
  }
  return { row: null, short: !/^[ \t]*$/.test(text.slice(at)) };
}

/** Whether the box shows exactly `text`. A box that is not the text waits and is refused at the
 *  deadline, never entered on trust. */
function holdsBox(text: string, box: Box): boolean {
  const read = readsBack(text, box);
  return read.row === null && !read.short;
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

/** What one CLI's box does with a paste of its own text, past the rows it draws: the most rows
 *  it draws, the columns the pane keeps beside the text, and the longest paste it paints itself
 *  before replacing it with a marker that hides the text. Every figure comes from a capture at
 *  54 by 23, the pane `up` creates (`test/fixtures/.../README.md` names each file); a CLI with no
 *  entry here is never split and its message travels in one paste, exactly as it always has.
 *
 *  - Codex: the seven-rule message (17 lines, 1193 characters) wraps to 30 rows at 50 columns;
 *    the box draws its last 19 and scrolls the rest out of the pane (`rules-scrolled.txt` — the
 *    screen also reads `unknown`), so no whole paste can be verified. No marker replaces the
 *    text at that length. 19 rows is the pane's own scroll limit: a 19-row text still draws all
 *    19 (`rules-fit-19.txt`), a 20-row text draws 19 and drops the first (`rules-fit-20.txt`).
 *  - Cursor: a paste of more than 800 characters comes back as `[Pasted text #1 +17 lines]`,
 *    with none of the text drawn (`rules-pasted.txt` reads `unsent` and no row of its box is a
 *    row of the text); 800 characters or fewer are drawn as text (`rules-threshold-800.txt`
 *    draws the text, `rules-threshold-801.txt` is the marker). The box draws at most six rows
 *    before scrolling its top out (`rules-fit-6.txt` reads back, `rules-fit-7.txt` draws the
 *    prompt glyph on the second typed row, so no row of the box is the text's own first row). */
type Budget = { rows: number; inset: number; chars: number };
const BUDGETS: Record<string, Budget> = {
  codex: { rows: 19, inset: 4, chars: Number.POSITIVE_INFINITY },
  cursor: { rows: 6, inset: 7, chars: 800 },
};

/** The pane's last `WINDOW` lines are what every screen read classifies (`windowOf` in
 *  screen.ts). A part has to read back inside that window, and the window is spent on more than
 *  the box: the read carries one trailing empty line of its own, the status row sits under the
 *  box, the box is followed by its frame rows, and the row directly above its input row must be
 *  blank *inside* the window (the core reads `unknown` when the input row is the window's first
 *  line). What is left is the box's rows. */
const WINDOW = 20;

/** The most rows a part may draw: the box's own limit from the capture, and what the reading
 *  window can still show. Measured at 54 by 23: Codex draws 16 rows and reads back, 17 draws and
 *  reads `unknown` (`rules-fit-16.txt`, `rules-fit-17.txt`); Cursor's own six-row limit binds
 *  first. Zero for a CLI with no captured box limit: it is pasted whole. */
function partRows(cli: string): number {
  const budget = BUDGETS[cli];
  if (!budget) return 0;
  const frame = screenData(cli)?.composer.frameRows ?? 0;
  return Math.min(budget.rows, WINDOW - 3 - frame);
}

/** The columns the pane itself draws the text in, from its own size, or zero when the size is
 *  unknown. */
function drawnWidth(cli: string, size: PaneSize | null): number {
  const budget = BUDGETS[cli];
  if (!size || !budget) return 0;
  return Math.max(20, size.width - budget.inset);
}

/** The columns a part is sized for: two narrower than the pane draws the text in, so a wrap
 *  breaking a column earlier than the pane breaks it only makes a part shorter than the rows it
 *  was sized for, never taller. */
function partWidth(cli: string, size: PaneSize | null): number {
  const drawn = drawnWidth(cli, size);
  return drawn === 0 ? 0 : Math.max(20, drawn - 2);
}

/** The rows a box draws for `text` at `width` columns: a line longer than the width breaks at the
 *  last space that still fits — at the width itself when it has no space — and its continuation
 *  rows start at the text column without the run it broke at. The rule the captures show Codex
 *  and Cursor wrapping by; used to size a part, never to verify one. */
function drawnRows(text: string, width: number): number {
  let rows = 0;
  for (const line of text.split('\n')) {
    rows += 1;
    let rest = line;
    while (rest.length > width) {
      const at = rest.lastIndexOf(' ', width);
      const cut = at > 0 ? at : width;
      rest = rest.slice(cut).replace(/^ +/, '');
      rows += 1;
    }
  }
  return rows;
}

/** The parts a message goes in on this pane, each a run of whole lines, or `whole` when nothing
 *  measured says the paste needs splitting — no pane size, or no captured budget for the CLI:
 *  the message then travels in one paste, exactly as it always has. `tooLong` names the line no
 *  part can hold. The greedy run keeps the message's own order, so its header is in the first
 *  part and its closing line in the last. */
function planParts(
  cli: string,
  text: string,
  size: PaneSize | null,
): { parts: string[] } | { tooLong: number } | 'whole' {
  const width = partWidth(cli, size);
  const rows = partRows(cli);
  const budget = BUDGETS[cli];
  if (!budget || width === 0 || rows === 0) return 'whole';
  const fits = (lines: string[]): boolean => {
    const joined = lines.join('\n');
    return drawnRows(joined, width) <= rows && joined.length <= budget.chars;
  };
  const parts: string[] = [];
  let current: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (fits([...current, line])) { current.push(line); continue; }
    if (current.length === 0) return { tooLong: index + 1 };
    parts.push(current.join('\n'));
    current = [line];
    if (!fits(current)) return { tooLong: index + 1 };
  }
  if (current.length > 0) parts.push(current.join('\n'));
  return parts.length > 1 ? { parts } : 'whole';
}

/** Which part a stop happened on: 1-based when the message went in parts, null when it went
 *  whole; `sent` counts the parts submitted before it. */
type At = { part: number | null; parts: number; sent: number };

/** The refusal for a stop at the reading the pane shows now: the box's own rows, the part, and
 *  nothing typed yet. */
function stopAt(cli: string, at: At, stop: Stop, screen: string | undefined): Refusal {
  const box = readBox(cli, screen);
  return {
    stop,
    typed: false,
    sent: at.sent,
    kind: readScreen(cli, screen).kind,
    rows: box === null ? 0 : 1 + box.rows.length,
    expected: 0,
    row: null,
    line: null,
    part: at.part,
    parts: at.parts,
  };
}

/** The refusal for a wait that ended with `part` typed into the box, whatever the wait: the
 *  first row that did not read back as the part's own, and the rows the part draws to at the
 *  pane's own width. */
function stoppedOn(cli: string, size: PaneSize | null, at: At, stop: Stop, screen: string | undefined, part: string): Refusal {
  const why = stopAt(cli, at, stop, screen);
  why.typed = true;
  const width = drawnWidth(cli, size);
  why.expected = width === 0 ? 0 : drawnRows(part, width);
  const box = readBox(cli, screen);
  why.row = box === null ? null : readsBack(part, box).row;
  return why;
}

/** What the report says the read-back saw: the reading, and the rows the box drew of the rows
 *  the text draws to, when both were read. */
function reading(why: Refusal): string {
  const rows = why.rows > 0 && why.expected > 0
    ? `, ${why.rows} row${why.rows === 1 ? '' : 's'} seen of ${why.expected}`
    : '';
  return `the screen read ${why.kind}${rows}`;
}

/** What the owner does next, per reading. */
function nextStep(why: Refusal): string {
  switch (why.stop) {
    case 'line':
      return `shorten that line in the team file, then run up again`;
    case 'leftover':
      return `press Enter in its pane to send what is there, or clear its box (Ctrl-C), then run up again`;
    case 'typing':
      return `run up again`;
    default:
      break;
  }
  switch (why.kind) {
    case 'permission':
    case 'trust':
    case 'question':
      return `answer it in its pane, then run up again`;
    case 'working':
      return `wait for its turn to finish, then run up again`;
    case 'unsent':
    case 'idle':
      return `read its box, then run up again`;
    default:
      return `read its pane, then run up again`;
  }
}

/** The line a stopped delivery is reported with, and the line the log keeps: the reading, the
 *  part it stopped at, and what the owner does next. It holds no row of the screen — the caller
 *  prints `why.row` to the terminal alone. `team` never clears a box it could not verify: the
 *  text a stop leaves behind stays in the pane, and the line says so. */
export function refusalReport(why: Refusal): string {
  const at = why.part === null ? '' : `part ${why.part} of ${why.parts}: `;
  const sent = why.sent === 0 ? '' : `parts 1-${why.sent} of ${why.parts} were sent; `;
  switch (why.stop) {
    case 'line':
      return `rules not typed: line ${why.line} of the message is taller than its box draws; ${nextStep(why)}`;
    case 'screen':
      return `rules not typed: ${sent}${at}${reading(why)}; ${nextStep(why)}`;
    case 'leftover':
      return `rules not typed: ${sent}${at}its box already holds text that is not the rules message; ${nextStep(why)}`;
    case 'typing':
      return `rules not typed: ${sent}${at}the pane took no text (${reading(why)}); ${nextStep(why)}`;
    case 'read-back':
      return `rules typed, not sent: ${at}the read-back didn't match (${reading(why)}); the rules sit in its box, unsent: `
        + `press Enter in its pane to send them, or clear the box (Ctrl-C), then run up again`;
    case 'ack':
      // A box that still holds the text after Enter never took the key: the rules sit unsent,
      // and the report says so rather than claiming a send.
      return why.typed && why.kind === 'unsent'
        ? `rules typed, not sent: ${sent}${at}its box still holds them after Enter (${reading(why)}); `
          + `press Enter in its pane to send them, or clear the box (Ctrl-C), then run up again`
        : `${sent}${at}the seat did not come back to its idle prompt (${reading(why)}); ${nextStep(why)}`;
  }
}

/** A first message is accepted only after working is observed with the composer empty again.
 *  A message taller than the box draws — or one whose CLI replaces a long paste with a marker —
 *  goes in parts, each a run of whole lines, each verified before its own Enter; the next part is
 *  typed only after the seat has come back to its idle prompt, never onto leftover text, and
 *  delivery stops at the first part it cannot verify. A box that already holds exactly the whole
 *  message is verified and sent, never typed onto again. */
export async function deliverRules(cli: string, text: string, seconds: number, io: Delivery): Promise<boolean | 'no-agent'> {
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(io.foreground(), names);
  const free = () => ['idle', 'done'].includes(io.status() ?? '');
  const size = io.size?.() ?? null;
  const plan = planParts(cli, text, size);
  if (plan !== 'whole' && 'tooLong' in plan) {
    io.report?.({
      stop: 'line', typed: false, sent: 0, kind: readScreen(cli, io.screen()).kind,
      rows: 0, expected: 0, row: null, line: plan.tooLong, part: null, parts: 0,
    });
    return false;
  }
  const parts = plan === 'whole' ? [text] : plan.parts;
  if (!live()) return 'no-agent';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const at: At = { part: parts.length > 1 ? i + 1 : null, parts: parts.length, sent: i };
    const report = (why: Refusal): false => { io.report?.(why); return false; };
    if (!live()) return 'no-agent';
    const kind = readScreen(cli, io.screen()).kind;
    if (!free() || (kind !== 'idle' && kind !== 'unsent')) return report(stopAt(cli, at, 'screen', io.screen()));
    // The resumed delivery: a box that already holds exactly the whole message is verified and
    // sent. A box holding anything else is left alone — `team` never types a second copy onto
    // the first, and never clears a box it could not verify.
    const resumed = i === 0 && parts.length === 1 && kind === 'unsent' && boxState(cli, part, io.screen()) === 'ready';
    if (!resumed) {
      if (kind !== 'idle') return report(stopAt(cli, at, 'leftover', io.screen()));
      if (!io.type(part)) return report(stopAt(cli, at, 'typing', io.screen()));
    }
    const deadline = io.now() + seconds * 1000;
    // Terminal rendering can lag send-text. Never press Enter until the box is verified to hold
    // the text: an ordinary box reads `unsent`, and a box that folded the paste counts only when
    // the tail and hidden-row count it shows are the ones the typed text renders to.
    for (;;) {
      const state = boxState(cli, part, io.screen());
      if (state === 'ready') break;
      if (!free() || state === 'no' || io.now() >= deadline) {
        return report(stoppedOn(cli, size, at, 'read-back', io.screen(), part));
      }
      const before = io.now();
      await io.sleep(100);
      if (io.now() <= before) return report(stoppedOn(cli, size, at, 'read-back', io.screen(), part));
    }
    // Re-read immediately before Enter. The agent is asked again: it may have exited since the
    // paste, and a dialog that appeared gets no key; a folded box that no longer matches the text
    // gets none either.
    if (!live()) return 'no-agent';
    if (!free() || boxState(cli, part, io.screen()) !== 'ready' || !io.enter()) {
      return report(stoppedOn(cli, size, at, 'read-back', io.screen(), part));
    }
    for (;;) {
      const status = io.status();
      const screen = io.screen();
      const composer = screen === undefined ? { kind: 'unknown' as const } : classifyComposer(cli, screen.split('\n'));
      if (status === 'working' && composer.kind === 'idle') break;
      // The part was submitted and no ready prompt was seen. Nothing about it is confirmed: the
      // parts confirmed before it are `i`, and this one's box is read as the screen shows it.
      const kind = readScreen(cli, io.screen()).kind;
      if (kind === 'trust' || kind === 'permission' || kind === 'question' || io.now() >= deadline) {
        return report(stoppedOn(cli, size, at, 'ack', io.screen(), part));
      }
      const before = io.now();
      await io.sleep(100);
      if (io.now() <= before) return report(stoppedOn(cli, size, at, 'ack', io.screen(), part));
    }
    if (i === parts.length - 1) return true;
    // A part that is not the last waits for the seat to come back to its idle prompt: the next
    // part is never typed over a running turn.
    for (;;) {
      if (free() && readScreen(cli, io.screen()).kind === 'idle') break;
      const kind = readScreen(cli, io.screen()).kind;
      if (kind === 'trust' || kind === 'permission' || kind === 'question' || io.now() >= deadline) {
        return report(stopAt(cli, { ...at, sent: i + 1, part: i + 2 }, 'ack', io.screen()));
      }
      const before = io.now();
      await io.sleep(100);
      if (io.now() <= before) return report(stopAt(cli, { ...at, sent: i + 1, part: i + 2 }, 'ack', io.screen()));
    }
  }
  return true;
}
