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
- `permission.txt`: reconstructed from an operator's quote of a real pane, not a capture
  (the line widths are approximate). A command permission prompt (`Requesting permission for:`
  with numbered options, navigation footer, and model statusline).
- `permission-cut.txt`: constructed from `permission.txt`, not a capture. The lines above the
  rule, and the rule, are removed, which is the last-20-line window once a command of about ten
  lines has pushed that rule out.
- `folded-rules.txt`: constructed, not a capture. A 54-column pane's composer holding a folded
  multi-line paste: the box's top rule, `↑ 19 more lines`, the last three rows of the text, the
  bottom rule, the model footer. The rows are the rules message `test/launch/antigravity.test.ts`
  names, hard-wrapped at 54 columns (a line longer than the width split into width-sized chunks,
  no word wrapping): 24 rows, 21 hidden. The tail is the worktree line's last row and the closing
  line, which the rules text gained in 0.1.2. The header block is copied from `unsent.txt`.

Paths, user email, plan, and conversation UUID are replaced with placeholders. Shell launch scrollback
before Antigravity's header banner is removed. All other visible text is retained, including the
box borders, prompts, and model footer (`Gemini 3.8 Flash · high`). Unknown screens permit no input.
No vendor configuration in `~/.gemini` was edited.

## Constructed: delivery-verification boxes

Not captures. `test/launch/antigravity.test.ts` builds the post-paste box from `idle.txt`:
the bare `>` row is replaced by `> ` and the first line of the typed text, and each later
line is drawn at two columns, the continuation indent `unsent.txt` shows. The fold tests
edit `folded-rules.txt`: the reviewer's zero-count marker with an unrelated tail, and
counts of 0 and 99 against the same 24-row text. Those screens are constructed too, and
each test names what it changes; a fold marker is never submitted unverified. No capture
shows Antigravity wrapping an ordinary composer line, so no wrap is modelled for it: a
box whose rows read back as runs of the typed text laid out in order is entered, and one
whose rows show anything else — another text, an extra row, one character changed, a
collapsed space, a blank row the text does not have at that place — is never.
