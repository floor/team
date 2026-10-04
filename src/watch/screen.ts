// What a pane's visible text shows, read against the shapes of its CLI. A screen that matches no
// shape is "unknown": never ready, never idle, and never grounds for typing anything.
import { readFileSync } from 'node:fs';
import { antigravityComposer, antigravityScreen } from '../profiles/antigravity-screen.ts';
import { codexComposer, codexScreen } from '../profiles/codex-screen.ts';
import { cursorComposer, cursorScreen } from '../profiles/cursor-screen.ts';
import { classifyLines, composeLines } from './screen-core.ts';
import type { ScreenData } from './screen-data.ts';
import { loadScreen } from './screen-file.ts';

export type Screen =
  | { kind: 'idle' }                 // the idle prompt, with an empty input box
  | { kind: 'working' }              // a turn is running: herdr's status would already be stale
  | { kind: 'unsent' }               // text left in the input box
  | { kind: 'permission' }           // a permission dialog: its owner's to answer
  | { kind: 'trust' }                // a workspace trust question: left unanswered
  | { kind: 'question' }             // a question the agent asked: the operator's to act on
  | { kind: 'unknown' };

type Classify = (lines: string[]) => Screen;

// claude-code is data. The other three stay code until they are ported; the core still
// calls them, so their order does not move.
const DATA: Record<string, ScreenData> = {
  'claude-code': loadScreen(readFileSync(new URL('../profiles/claude-code.yaml', import.meta.url), 'utf8')),
};

const CODE: Record<string, Classify> = {
  codex: codexScreen,
  antigravity: antigravityScreen,
  cursor: cursorScreen,
};

const COMPOSERS: Record<string, Classify> = {
  codex: codexComposer,
  antigravity: antigravityComposer,
  cursor: cursorComposer,
};

// The window every pattern sees: the pane's last 20 lines, each trimmed at the end.
function windowOf(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).slice(-20);
}

/** Every stage, in the core's order. The first one that matches wins. */
export function classify(cli: string, lines: string[]): Screen {
  const window = windowOf(lines);
  const data = DATA[cli];
  if (data) return classifyLines(data, window);
  return CODE[cli]?.(window) ?? { kind: 'unknown' };
}

/** The composer alone. A running turn would otherwise hide an empty input box. */
export function classifyComposer(cli: string, lines: string[]): Screen {
  const window = windowOf(lines);
  const data = DATA[cli];
  if (data) return composeLines(data, window);
  return COMPOSERS[cli]?.(window) ?? { kind: 'unknown' };
}

export function readScreen(cli: string, screen: string | undefined): Screen {
  if (screen === undefined) return { kind: 'unknown' };
  return classify(cli, screen.split('\n'));
}
