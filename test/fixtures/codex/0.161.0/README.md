# Codex 0.161.0 terminal captures

Captured from the installed macOS Codex CLI (`codex-cli 0.161.0`) on 2026-10-08 with
herdr 0.7.1, `pane read --source visible --lines 200` (plain), in a scratch session of
my own with one Codex pane, 54 by 23 — the size `up` creates. The CLI was launched the
way a seat is launched, plus a pinned model so the status row is one the shipped profile
reads:

`codex -a never -s danger-full-access --no-daemon --no-alt-screen -m gpt-5.6-terra -c check_for_update_on_startup=false`

The pinned model was accepted. No trust dialog and no update screen appeared, and nothing
was answered.

`pane read --source visible` returns the pane's screen with leading and trailing blank
rows trimmed. The reading below was taken from the returned text, as delivery reads it.

- `idle.txt`: the empty box at boot, read `idle`. The banner's workspace path is replaced by
  `<workspace>`; the line is not part of any box, so the shorter stand-in moves nothing.
  At this width the status row wraps: `weekly 9` stays on the status line and the next
  line is the ellipsis alone.
