# Herdr process-info

Cleaned `pane process-info` objects. Arguments past the program name, command lines, working directories, and pane ids are withheld. Nothing here was typed into a live pane for this test.

- `claude-with-caffeinate.json`: two foreground entries. The first `argv0` is `caffeinate`. The second `argv0` is `claude` and its `name` is a version.
- `claude-plain.json`: the same pair, with a different version in `name`.
- `cursor-agent.json`: one entry. `argv0` is `cursor-agent` and `name` is `node`.
- `shell-back.json`: one entry, the pane's own shell — its pid is `shell_pid`, so the pane is at its shell.
- `zsh-script.json`: one entry whose `argv0` is `zsh` but whose pid is not `shell_pid`: a script's own child shell, which argv0 alone cannot tell from the pane's shell.
- `zsh-after-exit.json`: captured 2026-10-07 from herdr 0.7.1 in a scratch session of the
  capture's own, right after Claude Code 2.1.292 (a GLM endpoint) was stopped with `/exit`
  typed by hand: the pane's own shell is the foreground process again, its pid equal to
  `shell_pid` and the foreground group the shell's. Cleaned like the rest; the pids are the
  capture's own.
