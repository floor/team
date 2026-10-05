// Each CLI shows its model in its own words. The profile's status_model rules turn a pane's
// visible text into the file's two fields, `model` and `version`, or null when the text doesn't
// show them: "unread" is never a mismatch. The last six lines are the window. A line the rules
// claim but cannot name clears an earlier match; that is how an unknown Codex footer stays unread.
import { stripSgr } from '../ansi.ts';
import { statusOnLine } from '../profiles/profile.ts';

export type Running = { model: string; version: string };

/** The screen names a model, and it is not the file's. Unread is never a difference. */
export function modelDiffers(
  running: Running | null,
  declared: { model: string; version: string },
): running is Running {
  return running !== null && (running.model !== declared.model || running.version !== declared.version);
}

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
