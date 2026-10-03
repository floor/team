# Codex 0.157.0 terminal captures

Captured from the installed macOS Codex CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `team-test-codex`.
There was at most one Codex seat at a time. The session was stopped and deleted;
the default session had eight agents before and after. Config and auth hashes were unchanged.

- `startup.txt`: `codex -a never -s danger-full-access --no-daemon --no-alt-screen`
  reached an update notice. Its workspace was closed without input.
- `trust.txt`: the same command with the invocation-only
  `-c check_for_update_on_startup=false`, in an untrusted worktree. The workspace
  was closed without answering the trust question.
- `idle.txt`, `unsent.txt`, `working.txt`, `rules-accepted.txt`: the second command
  in an already-trusted folder. The rules message was pasted, read back, and submitted.
  `working.txt` coincided with herdr reporting `working`; the composer was empty.
  The only model response was `RULES_RECEIVED`. It was instructed to use no tools or files.
- `exit-typed.txt`, `exit.txt`: `/exit` pasted at idle, read back, then submitted.
  Herdr subsequently listed zero agents and the foreground process was `zsh`.

Paths and the session UUID are replaced with placeholders. Shell launch scrollback before
Codex's header is removed from idle and unsent captures. All other visible text is retained,
including wrapping and the configured model footer. The model was the owner's CLI default;
the profile does not select a model. These fixtures do not assert a vendor permission or
question layout that was not observed. Unknown screens permit no input.

The update-check override was for capture only, not added by the profile. It is documented in
[OpenAI's configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
No update, login, trust, or settings dialog was answered, and no vendor configuration was edited.
