# Antigravity (agy) 1.2.16 terminal captures

Captured from the installed macOS Antigravity CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `team-test-agy`.
There was at most one Antigravity seat at a time. The session was stopped and deleted;
the default session had nine agents before and after. Config and auth hashes were unchanged.

- `trust.txt`: `AGENT_UNATTENDED=1 agy --dangerously-skip-permissions` launched in a fresh,
  untrusted temporary directory. The workspace trust prompt appeared (`Do you trust the contents
  of this project?`). The workspace was closed without answering the question.
- `idle.txt`, `unsent.txt`, `working.txt`, `rules-accepted.txt`: the same launch command in
  an already-trusted folder. The rules message was pasted, read back, and submitted.
  `working.txt` coincided with the CLI showing `Generating...` and herdr reporting `working`
  with the composer empty again. The model response was `RULES_RECEIVED`.
- `exit-typed.txt`, `exit.txt`: `/exit` typed at idle, read back, then submitted.
  Herdr subsequently listed zero agents and the foreground process was `zsh`.

Paths, user email, plan, and conversation UUID are replaced with placeholders. Shell launch scrollback
before Antigravity's header banner is removed. All other visible text is retained, including the
box borders, prompts, and model footer (`Gemini 3.8 Flash · high`). Unknown screens permit no input.
No vendor configuration in `~/.gemini` was edited.
