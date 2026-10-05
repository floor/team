// Each CLI shows its model in its own words. The profile's status_model rules turn a pane's
// visible text into the file's two fields, `model` and `version`, or null when the text doesn't
// show them: "unread" is never a mismatch. The last six lines are the window. A line the rules
// claim but cannot name clears an earlier match; that is how an unknown Codex footer stays unread.
// Where the profile pins the status row's place (`status_below`), the model is read from that
// row alone — the same line the composer reads, so the two cannot disagree — and a screen that
// shows no such row names no model.
import { stripSgr } from '../ansi.ts';
import { patternWitness, statusOnLine, statusWitnesses } from '../profiles/profile.ts';
import type { StatusBelow } from '../watch/screen-data.ts';
import { screenData, statusRow } from '../watch/screen.ts';

export type Running = { model: string; version: string };

/** The screen names a model, and it is not the file's. Unread is never a difference. */
export function modelDiffers(
  running: Running | null,
  declared: { model: string; version: string },
): running is Running {
  return running !== null && (running.model !== declared.model || running.version !== declared.version);
}

export function runningModel(cli: string, screen: string): Running | null {
  const data = screenData(cli);
  const composer = data?.composer;
  if (data && composer && (composer.mode === 'status-last' || composer.mode === 'status-then-one') && composer.statusBelow) {
    // The row the profile pinned, and nothing else on the pane. A grammar-looking line out of
    // place is ordinary text; a screen without the row names no model.
    const row = statusRow(data, screen);
    if (row === null) return null;
    const hit = statusOnLine(cli, row);
    return hit === 'unreadable' || hit === null ? null : hit;
  }
  let found: Running | null = null;
  // The pane's text may keep its ANSI styling; the model is read from the plain form.
  for (const line of stripSgr(screen).split('\n').slice(-6)) {
    const hit = statusOnLine(cli, line);
    if (hit === 'unreadable') found = null;
    else if (hit) found = hit;
  }
  return found;
}

// The model a seat runs, as far as its screen can say. Claude Code names Claude's families only:
// for a seat that runs another maker's model through it, the line says nothing to compare, so
// the seat is unread rather than wrong.
export function seatModel(seat: { cli: string; model: string }, screen: string | undefined): Running | null {
  if (screen === undefined) return null;
  if (seat.cli === 'claude-code' && !seat.model.startsWith('Claude ')) return null;
  return runningModel(seat.cli, screen);
}

/**
 * Whether the seat's declared model could ever be read off its screen: `seatModel`'s question
 * asked of the model the file declares instead of the text the screen shows. A line a rule
 * accepts, with the declared model's own words in the capture its templates name — inside the
 * frame the profile's place pins, when it pins one — is run through the real `runningModel`; the
 * answer is yes only when it reads back as exactly this model — and this version, when the seat
 * has one. A model the rules' own capture cannot spell (another maker's name, a made-up family)
 * leaves a line that doesn't match, or no line at all. A seat it answers no to is unread for as
 * long as it runs — `status` prints its model `(unread)` with a note, and the watch never reports
 * a drift for it — so no launch-time finding may claim the running seat checks it.
 */
export function canShowModel(seat: { cli: string; model: string; version?: string }): boolean {
  const data = screenData(seat.cli);
  const composer = data?.composer;
  const placed = composer && (composer.mode === 'status-last' || composer.mode === 'status-then-one') ? composer : undefined;
  return statusWitnesses(seat.cli, seat.model, seat.version).some((line) => {
    // Where the row's place is pinned, the witness is a bare row no screen shows: the reader
    // would refuse it exactly as it refuses a quoted row out of place. The evidence is the
    // smallest screen the place admits — the profile's input row above, its workspace line
    // below — so the answer stays "readable" for every model a real frame can name.
    const below = placed?.statusBelow;
    const screen = below && !below.except?.test(line) ? placedFrame(placed.prompt, below, line) : line;
    if (screen === null) return false;
    const hit = runningModel(seat.cli, screen);
    return hit !== null && hit.model === seat.model && (seat.version === undefined || hit.version === seat.version);
  });
}

/**
 * The smallest screen the placed read admits around a witness line: the input row it scans up
 * to, the row, and the workspace line it needs directly below and last. Both frame lines are
 * spelled by the same walk the witness lines are, never retyped here. Null when either cannot
 * be spelled — no line the pattern accepts, so no screen the read accepts shows this model.
 */
function placedFrame(prompt: RegExp, below: StatusBelow, line: string): string | null {
  const input = patternWitness(prompt.source);
  const workspace = patternWitness(below.line.source);
  if (input === null || workspace === null) return null;
  return `${input}\n${line}\n${workspace}`;
}
