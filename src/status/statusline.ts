// Each CLI shows its model in its own words. The profile's status_model rules turn a pane's
// visible text into the file's two fields, `model` and `version`, or null when the text doesn't
// show them: "unread" is never a mismatch. The last six lines are the window. A line the rules
// claim but cannot name clears an earlier match; that is how an unknown Codex footer stays unread.
import { stripSgr } from '../ansi.ts';
import { statusOnLine, statusWitnesses } from '../profiles/profile.ts';

export type Running = { model: string; version: string };

export function runningModel(cli: string, screen: string): Running | null {
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
 * accepts, with the declared model's own words in the capture its templates name, is run
 * through the real `runningModel`; the answer is yes only when it reads back as exactly this
 * model — and this version, when the seat has one. A model the rules' own capture cannot spell
 * (another maker's name, a made-up family) leaves a line that doesn't match, or no line at all.
 * A seat it answers no to is unread for as long as it runs — `status` prints its model `(unread)`
 * with a note, and the watch never reports a drift for it — so no launch-time finding may claim
 * the running seat checks it.
 */
export function canShowModel(seat: { cli: string; model: string; version?: string }): boolean {
  return statusWitnesses(seat.cli, seat.model, seat.version).some((line) => {
    const hit = runningModel(seat.cli, line);
    return hit !== null && hit.model === seat.model && (seat.version === undefined || hit.version === seat.version);
  });
}
