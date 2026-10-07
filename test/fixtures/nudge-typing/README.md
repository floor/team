# Nudge-typing captures, Claude Code

What the watch's nudge sees between typing its one line into the operator's box and the Enter,
captured on 2026-10-06 to prove the nudge fix against real screens.

Captured with herdr 0.7.1, `pane read <pane> --source visible --lines 200 --format ansi` — the
call and window the watch's own screen reader makes — CRLF folded to LF as `paneRead` returns
it — from a plain `claude` (Claude Code 2.1.291) in a pane of a scratch project in a scratch
herdr session of mine. The pane was the captures' own; no other seat was read or typed into.
The line is the watch's one constant, `Team watch: reports are waiting in .agents/team.log`,
typed with `pane send-text` exactly as the watch's `typeText` sends it.

The pair is the point: `pane send-text` returns before the pane draws what it sent, so the
reading taken the instant after the typing is still the idle prompt with its placeholder — the
text is not drawn yet — and the reading taken about two seconds later is the box holding
exactly the line, wrapped by this pane's width onto its continuation row. The watch waits for
the draw (the same bounded wait the exit typing makes), reads the box back row by row, and
only then presses Enter.

- `claude-code-nudge-idle-ansi.txt`: the operator's idle box the instant after the nudge line was
  sent. The placeholder is faint; the box is empty, the text not drawn yet. Reads `idle`, and the
  box does not read back as the line.
- `claude-code-nudge-partial-ansi.txt`: constructed fixture (made from the unsent capture by
  removing the wrapped continuation row; no real partial-draw screen has been captured, and
  the coverage contract must not claim one) modeling the operator's box after the prompt row
  has rendered, but before the continuation row draws. Reads `unsent`, but does not yet read
  back as the whole nudge text.
- `claude-code-nudge-unsent-ansi.txt`: the same pane about two seconds later. The box holds
  exactly the line — `Team watch: reports are waiting in` on the prompt row, `.agents/team.log`
  on the continuation row — and reads back as exactly the nudge's own text. Reads `unsent`.
