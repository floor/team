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

/** Whitespace-normalised: every run of whitespace to one space, ends trimmed. A wrap adds or
 *  drops a space at a row's end, and the typed text's own newlines stand for its rows: joined
 *  back by the profile's rule, the two read the same only where the wrap is the whole difference. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Whether the box's rows tile `text` in order: the first row opens it, each later row follows
 *  where the one before ended, and only the whitespace a wrap drops sits between them. The read
 *  for a profile whose captures show no composer wrap: its rows must be runs of the typed text
 *  laid out one after another. Anything else — another text, an extra row, one character
 *  changed — has a row that is not the text's and gets no Enter. */
function tiles(text: string, first: string, rows: string[]): boolean {
  if (!text.startsWith(first)) return false;
  let at = first.length;
  for (const row of rows) {
    if (row === '') continue;
    const found = text.indexOf(row, at);
    if (found < 0 || text.slice(at, found).trim() !== '') return false;
    at = found + row.length;
  }
  return text.slice(at).trim() === '';
}

/** Whether the box shows exactly `text`: the first line after the prompt and every continuation
 *  row at the box's own column — no more rows, no fewer, none changed. A continuation row that
 *  does not start at that column is not the text's own row and the box is not trusted. A box
 *  whose profile declares a wrap rule is joined by it — the rows continue each line, a space
 *  folded at a word boundary or nothing at a hard break — and then compared whitespace-normalised;
 *  a box whose profile declares none must tile the typed text with its own runs. Either way a box
 *  that is not the text waits and is refused at the deadline, never entered on trust. */
function holdsBox(text: string, box: Box): boolean {
  const pad = ' '.repeat(box.indent);
  const rows: string[] = [];
  for (const row of box.rows) {
    if (row === '') { rows.push(''); continue; }
    if (!row.startsWith(pad)) return false;
    rows.push(row.slice(pad.length));
  }
  if (box.wrap) {
    const joined = [box.first, ...rows].join(box.wrap.kind === 'hard' ? '' : ' ');
    return flatten(joined) === flatten(text);
  }
  return tiles(text, box.first, rows);
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
  if (!free() || readScreen(cli, io.screen()).kind !== 'idle' || !io.type(text)) return false;
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
  if (!free() || boxState(cli, text, io.screen()) !== 'ready' || !io.enter()) return false;
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
