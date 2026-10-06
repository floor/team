# Exit-typing captures, three CLIs

What `team down` and `team remove` see between typing an exit text and the Enter, captured on
2026-10-06 to prove `typeExit` (src/commands/down.ts) against real screens.

Captured with herdr 0.7.1, `pane read <pane> --source visible --lines 200 --format ansi` — the
call and window `down`'s own screen reader makes (`paneRead(pane, 200, session)`), CRLF folded to
LF as `paneRead` returns it — from *plain* `claude` (Claude Code 2.1.291), `codex` (0.160.0) and
`cursor-agent` (2026.10.01-14929f9), no vendor launcher, each in its own pane of a scratch
project in a scratch herdr session of mine. The panes were the captures' own; no other seat was
read or typed into. No text was swapped for neutral words — the scratch project path and the
model name the scratch seat ran under are as the CLI drew them — so every byte, SGR included, is
the capture's own.

Each CLI has the same pair, and the pair is the point: `pane send-text <pane> /exit` returns
before the pane draws what it sent, so the reading taken the instant after the send is still the
idle screen with its placeholder — the text is not drawn yet — and the reading taken about two
seconds later is the box holding exactly `/exit` with the slash menu open over it. `typeExit`
reads the box between the send and the Enter and only presses Enter on the second reading.

- `claude-code-idle-ansi.txt`: Claude Code at an empty, idle box, the reading the instant after
  `/exit` was sent. The placeholder is faint; the box is empty. Reads `idle`.
- `claude-code-unsent-ansi.txt`: the same pane about two seconds later. The box holds exactly
  `/exit`, the slash menu open above it. Reads `unsent`, and the box reads back as the typed text.
- `codex-idle-ansi.txt`: Codex at an empty, idle box, the instant after the send; its placeholder
  is `Ask Codex to do anything`. Reads `idle`.
- `codex-unsent-ansi.txt`: the same pane later. The box holds exactly `/exit` with the command
  menu's own `exit Codex` row above it. Reads `unsent`, box exactly the text.
- `cursor-idle-ansi.txt`: cursor-agent at an empty, idle box, the instant after the send; its
  placeholder is `Plan, search, build anything`. Reads `idle`.
- `cursor-unsent-ansi.txt`: the same pane later. The box holds exactly `/exit` with the slash
  menu's `→ /exit  Exit` rows below it. Reads `unsent`, box exactly the text.
- `claude-code-other-text-ansi.txt`: Claude Code's box holding `/exit now` — a command word plus
  an argument. Reads `unsent`, but the box does not read back as `/exit`: this is the screen the
  Enter must never go to, and the first row that differs is `/exit now`. Captured the same way,
  in the same pane as the pair above (its previous text cleared with the profile's `ctrl+c`).

## A seat with background work

Both screens are from a Claude Code seat that had run a background shell (`sleep 600` through the
Bash tool's background shell) and stayed at its prompt; the CLI's own status line says
`1 shell still running`, on the row the spinner ended on and again in the footer. A stop must
still read and type this box the same way, and the slash menu at the second reading is where an
Enter would land.

- `claude-code-shell-idle-ansi.txt`: the seat's idle box with the background shell running, the
  reading the instant after `/exit` was sent. Reads `idle`.
- `claude-code-shell-unsent-ansi.txt`: the same pane later, box exactly `/exit`, slash menu open,
  `1 shell still running` still over it. Reads `unsent`, box exactly the text.

A second pair is from a seat holding a scheduled task instead (made in-seat, `CronCreate`), so the
same two readings exist for a seat whose background work is not a shell. The task's own text is
in the screen above the box.

- `claude-code-scheduled-idle-ansi.txt`: that seat's idle box, the instant after the send. Reads
  `idle`.
- `claude-code-scheduled-unsent-ansi.txt`: the same pane later, box exactly `/exit`, slash menu
  open. Reads `unsent`, box exactly the text.

## The CLI's own question after the Enter

Both of these are what the pane shows about two seconds after the one Enter `typeExit` presses —
the seat did not exit. Asked to exit with background work outstanding, Claude Code answers with a
question of its own:

    Background work is running
    The following will stop when you exit:

    scheduled   · Runs once in 19m · Remind the user: time to stretch your legs — get
    task          …

    ❯ 1. Exit and stop tasks
      2. Stay

    Enter to confirm · Esc to cancel

`1. Exit and stop tasks` is preselected, so one more Enter confirms it and the CLI then exits —
the seat was back at its shell and out of herdr's agent list a moment later. The one Enter
`typeExit` presses does not answer this question, so a seat holding background work stays on this
screen and the `gone` step that follows can only run out its exit wait: the captures are here so
that reading is tested against the real screen. Both captured screens read `exit question` —
never `idle`, never `unsent` — so nothing that reads the screen would type into them, and the
kind is kept apart from the ordinary `question`, which no stop may ever answer. The profile
names both halves of the answer for this CLI: the stage this screen is read from
(`screen.exit_question`) and the one key that confirms it (`exit_confirm: enter`, beside the
screens' evidence in src/profiles/claude-code.yaml). The stage admits each of the two forms
below exactly, and a tail it cannot name reads as the ordinary question it looks like — the
comment beside the rules says why. Nothing but a stop presses that key.

What the other two CLIs do with background work, from their own runs of 2026-10-06 in the same
scratch session: Codex 0.160.0 asks nothing. With a backgrounded shell running, one Enter on
`/exit` put its pane back at its shell, herdr listing no agent for it, and its exit printed only
advice — "Stop the current turn: run codex agents, select this task, and press x." — so its
profile declares no `exit_confirm`: there is no question to confirm. cursor-agent
2026.10.01-14929f9 was not observed: its run never got past the CLI's own permission dialogs for
the backgrounding command ("Run this command? Not in allowlist: disown, echo, sleep", then for
`ps`), so no exit question with background work ever reached its pane; its `/exit` pair is the
one captured above, and its profile declares no `exit_confirm` either — from no run, not from a
run that found none.

- `claude-code-scheduled-question-ansi.txt`: the seat whose background work is the scheduled task
  above, the question listing it (`scheduled task · Runs once in 19m`).
- `claude-code-shell-question-ansi.txt`: the seat whose background work is the background shell,
  the same question listing `shell · sleep 600`.

### The three-choice form

The CLI draws this question in two forms. When the session is one the CLI can move into the
background, the list gains a choice between the marked one and `Stay`:

    Background work is running
    The following will stop when you exit:

    shell · sleep 600

    ❯ 1. Exit and stop tasks
      2. Move to background and exit
      3. Stay

    Enter to confirm · Esc to cancel

The preselected marker is still on `1. Exit and stop tasks`, the row the one Enter confirms. The
added value, `Move to background and exit`, is never what a stop confirms, and the profile
carries no key that could land on it.

- `claude-code-shell-move-question.txt`: the release run's own capture of this form, taken
  2026-10-06T21:37:29Z from its Claude pane after a `team down` of a seat holding a background
  shell, with `pane read <pane> --format text --lines 80` — the stdout of
  `briefs/032-proof-main-2.md` section e, copied byte for byte. Before the rule admitted this
  tail it read `question`, so the stop sent nothing and left the seat on this dialog. Reads
  `exit question`.
- `claude-code-shell-scheduled-move-question-ansi.txt`: my own scratch capture of the same form,
  taken the same way as the pair above (herdr 0.7.1 `pane read`, `--format ansi`), from a seat
  holding both kinds of background work at once — a background shell (`sleep 600`) and a
  scheduled task (`Every day at 3:00 AM`). The item rows follow the work: `shell · sleep 600`,
  and the scheduled task's label wrapped onto its own `task` continuation row. The pane ran
  Claude Code 2.1.292 and was created with the child-session marker the CLI's own warning names
  cleared (`--env CLAUDE_CODE_CHILD_SESSION=`): the panes that inherited that marker drew only
  the two-choice form above, which is why this capture needed a fresh full-height pane. Reads
  `exit question`.
- `claude-code-shell-scheduled-move-question-clipped-ansi.txt`: the same pane's dialog under a
  smaller layout. A pane too short for the item list draws the same dialog clipped by the CLI's
  own row budget — one item row, its `… +1 item` row, the marked choice and the footer, no other
  choice at all. The marked row is still the preselected `1. Exit and stop tasks`, so this is the
  first form clipped, not another dialog. Reads `exit question`.

## Constructed boundary screens

The exit question's stage reads three phrases, and prose quoting them above a live box must not
be read as the CLI's dialog: a rule matching them anywhere read an ordinary question as an exit
question, and a later stop would have sent its Enter into it. The screens below pin that
boundary: the first three quote the dialog's lines above a live question, and the last three
carry a tail no run has drawn. None is a capture; each names the file it was built from.

- `claude-code-exit-lines-quoted-question.txt`: constructed from
  `claude-code/2.1.289/question-plain.txt`. The exit question's two lines
  (`Background work is running`, `❯ 1. Exit and stop tasks`) are quoted in the transcript
  directly above the box's first rule — the box's own title, choices and rule lines are the
  capture's — and the footer is the common `Enter to confirm · Esc to cancel`. Reads `question`;
  before the stage read the dialog's own frame the three phrases matched anywhere and this read
  `exit question`.
- `claude-code-exit-lines-quoted-no-rule-question.txt`: constructed from the ordinary-question
  shape `test/screen-core.test.ts` pins for a question whose composer rule has scrolled out,
  with the same two quoted lines and that same shared footer quoted above it, the live title,
  `❯ 1. main` / `2. next` choices and footer below. A rule reading the three phrases anywhere
  still read this `exit question`; what tells it apart is the frame below the quoted choice
  row, where the live question draws rows that are no part of the exit dialog. With the stage's
  frame reads — the `❯` marker on the choice row itself, the footer as the window's last
  non-blank line, and `only_after`, which admits nothing under the choice row but the dialog's
  own `2. Stay` and that footer — a quote whose block has any other row below it is not the
  live dialog, and this reads `question`.
- `claude-code-exit-question-below-quote.txt`: constructed from
  `exit-typing/claude-code-shell-question-ansi.txt`, whose last 17 lines (the `▔` bar down to
  the footer) are kept byte for byte, with a three-line transcript quoting the same two lines
  placed above them. The real dialog sits below a quoting transcript and still reads
  `exit question`: the rule reads the bottom dialog's own choice row and footer, not the quote.
- `claude-code-exit-question-other-second-row.txt`: constructed from the release run's capture
  (`claude-code-shell-move-question.txt`) with its middle row renamed to `2. Delete everything
  and exit` — a second row no run has drawn. Each form names the second row it draws (`2. Stay`,
  or `2. Move to background and exit` with its `3. Stay`), and a tail whose second row is
  anything else is not this dialog. Reads `question`.
- `claude-code-exit-question-move-without-stay.txt`: the same capture with its `3. Stay` row
  removed. The move row with no last `Stay` under it is a tail neither form draws — and the
  choice a stop must never confirm. Reads `question`.
- `claude-code-exit-question-marker-on-move.txt`: the same capture with the marker moved to
  `2. Move to background and exit`, row 1 left unmarked. The reader takes the marker as the row
  the confirming key acts on; a stop means stop, so a screen whose selection sits on the move
  row is not the screen whose key this program may send. Reads `question`.
