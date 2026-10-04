# Cursor Agent 2026.10.01 terminal captures

Captured from the installed macOS `cursor-agent` CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `team-test-cursor`.
There was at most one Cursor seat at a time. The session was stopped and deleted;
the default session had eight agents before and after.

- `startup.txt` and `idle.txt`: `cursor-agent --force --sandbox disabled` in an
  already-trusted folder. No update, login, or trust dialog appeared. The first
  settled screen is the idle prompt, so both files are that screen.
- `trust.txt`: the same command in an untrusted directory. The workspace was
  closed without answering the trust question. `--trust` was not passed.
- `unsent.txt`, `working.txt`, `thinking.txt`, `rules-accepted.txt`: the same
  command in the already-trusted folder. The rules message was pasted, read back,
  and submitted. `working.txt` and `thinking.txt` coincided with herdr reporting
  `working`; the composer showed the empty follow-up placeholder and
  `ctrl+c to stop`. The only model response was `RULES_RECEIVED`. It was
  instructed to use no tools or files.
- `working-no-spinner.txt`: constructed from `working.txt` by removing the braille spinner line. Not a capture. That line sits several lines above the prompt, so a longer tool transcript pushes it out of the 20-line window. The prompt still ends in `ctrl+c to stop`.
- `follow-up-queue-two.txt`, `follow-up-queue-hint.txt`, `follow-up-queue-one.txt`,
  `follow-up-queue-typed.txt`: transcribed by the operator on 2026-10-04 from plain
  `herdr pane read` output of a working seat, with Cursor's follow-up queue open.
  **Transcribed, not captured with styling** — no CLI was started for them. Message
  text is replaced, widths are shortened and the box borders re-padded to one width,
  and the workspace path is `<workspace>`. The three frames show a running turn (the
  spinner verb differs: `Thinking` in the first two, `Reading` in the third) with one
  or two messages queued behind it and the empty `→ Add a follow-up` placeholder on
  the prompt row; frame 2 is frame 1 after one Enter, so its box top has scrolled out
  of the read. `follow-up-queue-typed.txt` puts frame 3's one-message box (frame 1's
  spinner and status rows) over the rules message typed on the prompt row, as
  `unsent.txt` has it.
- `exit-typed.txt`, `exit.txt`: `/exit` pasted at idle, read back, then submitted.
  The suggestion menu also listed `/quit`. Herdr subsequently listed zero agents
  and the foreground process was the shell.

Paths and the session id are replaced with placeholders. Shell launch scrollback
before Cursor Agent's header is removed from idle and unsent captures. All other
visible text is retained, including wrapping and the model footer. The model was
the owner's CLI default; the profile does not select a model. These fixtures do
not assert a permission or question layout that was not observed. Unknown screens
permit no input.

No trust, login, or settings dialog was answered, and no vendor configuration was edited.

## Constructed: delivery-verification boxes

Not captures. `test/launch/cursor.test.ts` builds the post-paste box from `idle.txt`:
the placeholder row is replaced by `  → ` and the first line of the typed text, and each
later line is drawn at four columns, the continuation indent `unsent.txt` shows (the
prompt row's own width). The captured `unsent.txt` is used as it is: Cursor wrapped its
sentence at that pane's 51 columns, and the composer's `wrap` rule — continuation at
the text column, broken at a space — reads the two rows as that sentence, so the
capture's test asserts the same Enter as an unwrapped box. Only the whitespace a row
break itself stands for is normalised: the run the break was made at, or a blank line
the typed text itself has. Inside a row every character must match, runs of spaces
included, and a blank row the text does not have at that place is never part of it. The
tests wrap the sentence themselves at 40- and 80-column panes, and refuse a wrapped box
that holds another text, an extra row, one character changed, a collapsed space, or a
blank row the text does not have.
