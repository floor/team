// What a pane's visible text shows, read against the shapes of its CLI. A screen that matches no
// shape is "unknown": never ready, never idle, and never grounds for typing anything.
// The text may keep its ANSI styling, as `herdr pane read --format ansi` reads it: matching
// runs on the plain form, and the styling tells a greyed suggestion from typed text.
import { readFileSync } from 'node:fs';
import { stripSgr } from '../ansi.ts';
import { classifyLines, composeLines, foldOf, statusRowOf, type Fold } from './screen-core.ts';
import type { ScreenData } from './screen-data.ts';
import { loadScreen } from './screen-file.ts';

export type { Fold };

export type Screen =
  | { kind: 'idle' }                 // the idle prompt, with an empty input box
  | { kind: 'working' }              // a turn is running: herdr's status would already be stale
  | { kind: 'unsent' }               // text left in the input box
  | { kind: 'permission' }           // a permission dialog: its owner's to answer
  | { kind: 'trust' }                // a workspace trust question: left unanswered
  | { kind: 'question' }             // a question the agent asked: the operator's to act on
  | { kind: 'unknown' };

function load(name: string): ScreenData {
  return loadScreen(readFileSync(new URL(`../profiles/${name}.yaml`, import.meta.url), 'utf8'), undefined, `${name}.yaml`);
}

// Every shipped CLI is data. The core owns the order.
const DATA: Record<string, ScreenData> = {
  'claude-code': load('claude-code'),
  codex: load('codex'),
  cursor: load('cursor'),
  antigravity: load('antigravity'),
};

// The window every pattern sees: the pane's last 20 lines. Styled lines are trimmed only past
// their last escape; the core trims each line's plain form for matching.
function windowOf(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).slice(-20);
}

/** Every stage, in the core's order. The first one that matches wins. */
export function classify(cli: string, lines: string[]): Screen {
  const data = DATA[cli];
  if (!data) return { kind: 'unknown' };
  return classifyLines(data, windowOf(lines));
}

/** The composer alone. A running turn would otherwise hide an empty input box. */
export function classifyComposer(cli: string, lines: string[]): Screen {
  const data = DATA[cli];
  if (!data) return { kind: 'unknown' };
  return composeLines(data, windowOf(lines));
}

export function readScreen(cli: string, screen: string | undefined): Screen {
  if (screen === undefined) return { kind: 'unknown' };
  return classify(cli, screen.split('\n'));
}

/** The folded form of a paste the pane's composer shows, or null. The shape only; the caller
 *  verifies it holds the text it typed before trusting it. */
export function readFold(cli: string, screen: string | undefined): Fold | null {
  const data = DATA[cli];
  if (data === undefined || screen === undefined) return null;
  return foldOf(data, windowOf(screen.split('\n')));
}

/** The one line a quota figure may come from: the composer's own status row, in the pane's last
 * 20 lines, read plain — a figure is never styled. Null for a CLI with no status line, and for
 * a window that shows no status row — a dialog, a question, a trust screen, a shell or an
 * unknown one reads no figures. */
export function statusRow(cli: string, screen: string | undefined): string | null {
  const data = DATA[cli];
  if (data === undefined || screen === undefined) return null;
  return statusRowOf(data, windowOf(stripSgr(screen).split('\n')));
}
