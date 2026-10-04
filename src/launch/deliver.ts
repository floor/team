import { reportedLiveAgent } from './agent.ts';
import { profileFor } from '../profiles/index.ts';
import { classifyComposer, readFold, readScreen, type Fold } from '../watch/screen.ts';

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

/** What the box holds right now: `ready` to submit, still rendering (`wait`), or a state that is
 *  never the typed text (`no`). An ordinary box is ready when it reads `unsent`; a folded one is
 *  ready only when its tail and hidden-row count are the ones the text renders to at the width
 *  the box reports. */
function boxState(cli: string, text: string, screen: string | undefined): 'ready' | 'wait' | 'no' {
  const kind = readScreen(cli, screen).kind;
  const fold = readFold(cli, screen);
  if (fold) {
    if (kind !== 'unsent' && kind !== 'unknown') return 'no';
    return holdsText(text, fold) ? 'ready' : 'wait';
  }
  if (kind === 'unsent') return 'ready';
  return kind === 'idle' ? 'wait' : 'no';
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
