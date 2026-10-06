# Claude Code 2.1.291 terminal captures

Captured on 2026-10-06 with herdr 0.7.1, `pane read --source visible`, from the
installed Claude Code 2.1.291. One Claude pane in a scratch session; the session
was stopped and deleted afterwards. A resume id drawn in a status row is replaced
by a same-length placeholder; nothing else in these files is changed.

`exit-idle.txt` and `exit-menu.txt` are one pane with no background shell, in a
scratch directory. `exit-after-enter.txt` is that pane after Enter.
`exit-shell-idle.txt`, `exit-shell-menu.txt` and `exit-question.txt` are a later
pane in scratch session `scratch-stop-for-real`, after `sleep` was backgrounded,
so the status line read `1 shell`.

- `exit-idle.txt`: the idle placeholder the instant `/exit` had been typed. The
  box does not hold the text yet. Read `idle`.
- `exit-menu.txt`: the same pane a moment later. The slash menu is open and the
  box holds exactly `/exit`. Read `unsent`.
- `exit-after-enter.txt`: Enter on that menu. The CLI has left; the pane is the
  shell and the menu is gone. Read `unknown`.
- `exit-shell-idle.txt`: the idle placeholder the instant `/exit` had been typed,
  with `1 shell` in the status line. Read `idle`.
- `exit-shell-menu.txt`: that pane a moment later. The slash menu is open, the
  box holds exactly `/exit`, and the status line still reads `1 shell`. Read
  `unsent`.
- `exit-question.txt`: Enter on that menu. The pane draws "Background work is
  running", with `❯ 1. Exit and stop tasks` selected, then "Move to background
  and exit" and "Stay". Read `question`.
