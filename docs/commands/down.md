# team down

Stops the team: asks every running seat to exit, closes its workspace, stops the watch, and stops
the herdr session. A seat is only asked when it is free — idle, with an empty input box — so a
working, blocked or half-typed seat is left running and named. A box that holds exactly this CLI's
exit text — an earlier run typed it and never confirmed it — is not half-typed text: when the
profile carries the one key that empties a box, the text is cleared with it and the exit typed
fresh, and when it does not, the seat is left running with the text named. `--dry-run` prints the
plan and runs nothing.

A seat the file renamed after `up` launched it is stopped all the same, under the name it was
launched with and the CLI the state records for it: what runs, not what the file now calls it.

## Synopsis

    team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]

## What it reads and writes

Reads the team file, this machine's approval store, the session's state
(`.agents/team.state.json`, for the watch's pid and the seats' recorded panes and CLIs), and herdr:
whether the session is running, its agents, each pane's screen and status, and each pane's
foreground processes. Writes `.agents/team.state.json` (the seats it stopped are dropped),
`.agents/team.log`, and, through herdr: the exit in each pane, the workspaces it closes, the watch's
process, the session it stops and the stopped session it clears — its own, just stopped. A
temporary seat's rules file goes with it, out of the project state folder; a declared seat's stays
for the next `up`. A team
file that no longer validates is replaced by the last copy that did, with a notice printed first:
`down` must keep working when the file breaks.

## Who may run it

The owner, the coordinator's seat, the operator's seat, and the approved delegate (below). The
seat is that name's, in a session
this project's state records — the file's session, or one the state records the caller's pane in —
on the pane the state records for that name in that session: a seat of another session, or a pane
merely renamed to the coordinator's or the operator's name, is refused — and so is a seat the state
records no pane for, or records on another pane than this call is on; those two refusals name the
seat and the repair. What that proves is placement, and no more: the state file is in the project,
and a process of the same user that writes its own pane there under the coordinator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the
same user. `--file` and `--session` are the owner's alone, from a terminal outside herdr: a
non-owner aiming either is refused before the flagged file or session is read at all.
A seat's
own call is refused by the `--abandon` flag, which only the owner may use. A seat that may stop the
team never stops the coordinator's or the operator's seat — only the owner does.

## The approved delegate

A pane the team file's `delegates` section lists for `down` — a pane outside the team's session —
may stop the team too. The section judges no other caller, and it never judges first: the ordinary
rule above is applied exactly as it is without a `delegates` section, and only where it has refused
does the delegate gate read the live team file directly — never the remembered copy and never the
last copy that validated, so a file that does not load carries no delegate and the rules above
stand. A caller that rule accepts keeps its own authority whatever the section says: the owner's
call never reaches the gate, and neither does the coordinator's or the operator's. A gate refusal
takes the place of the rule above, in the gate's own words, wherever that rule would have refused:
a real run exits 1, and a dry run prints `! down would refuse: <the gate's text>` and then the
plan, exit 0.

A delegated run stops the whole team — the coordinator's and the operator's seats included — and
never abandons. `--abandon`, `--session` and `--file` are the owner's: a delegate that passes one
is refused with the gate's text, and the flagged path or session is never read. The run judges the
file's own session, never one the caller's placement records, and it remembers nothing of the file
it read.

A run that passes its gate and proceeds to its effects appends one line to `.agents/team.log`
naming the delegate's pane. A dry run leaves no such line, and neither does a session that was
already idle: both return before any effect.

## Flags

| Flag | Meaning |
| --- | --- |
| `--dry-run` | print the plan, and the refusals the real run would stop on, and exit 0 — except a non-owner's `--session`, refused at once with no plan |
| `--wait` | give a working seat up to 120 seconds to come free, then stop it |
| `--abandon` | the owner's: close the workspace of a seat that can't be asked, typing nothing into it |
| `--session <name>` | the herdr session to stop, instead of `team.session`; the owner's alone — a delegate is refused it by the gate |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone — a delegate is refused it by the gate |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

    claude-keeper: stopped
    watch: stopped
    session beacon: stopped and cleared

A seat it stops prints `<seat>: stopped`; the watch prints `watch: stopped`; the session prints
`session <session>: stopped and cleared` — herdr keeps a stopped session listed, so `down` clears
the one it has itself just stopped, in the same run, and the next `up` starts from the beginning.
`up` never deletes a session: one stopped any other way keeps its refusal, with the command to run.
A clear that does not happen — herdr still reports the session running, or the delete fails —
prints `session <session>: stopped; it did not clear, run \`herdr session delete <session>\``
instead, and `down` still exits 0: the stop itself succeeded. A seat it does not stop prints one
`  skip` line and is named in the last line instead of the session being stopped. A seat whose box
already holds its exit text, on a CLI with a clearing key, is stopped as a free seat is — the
clearing key runs first — and a dry run says so in a note under its typing step:
`its box already holds this exit text; it is cleared first (<key>)`.

    claude-beacon: is working (`--wait` waits for it); left running
    session beacon: not stopped, 1 agent left in it

| Skip line | Meaning |
| --- | --- |
| `<seat>: is working (\`--wait\` waits for it); left running` | a turn is running |
| `<seat>: is blocked at a prompt, which \`team never answers\`; left running` | a permission dialog, a trust question or a question: only its owner answers it |
| `<seat>: holds unsent text in its input box; left running` | half-typed text would be lost |
| `<seat>: holds this CLI's exit text (<exit>) unsent in its input box; left running (the owner sends it or clears it in its pane)` | the box holds an earlier run's unconfirmed exit text, and the CLI has no key that empties a box |
| `<seat>: shows a screen the profile does not recognise; left running` | nothing is typed into a screen it can't read |
| `<seat>: the state doesn't say which CLI it runs, so it can't be asked to exit; left running (`team down --abandon` closes it without typing)` | the state predates the CLI record and the file no longer names the seat: nothing links its pane to a profile, so its owner closes it |
| `<seat>: left running; only the owner stops the coordinator's or the operator's seat` | a seat's own call, and this is the coordinator or the operator |
| `session default: herdr's default session is never stopped` | the default session is herdr's own |

It prints `session <session> is not running: nothing to stop` and exits 0 when there is nothing to
stop at all.

## Refusals

| Message | Exit |
| --- | --- |
| `team down: unknown option --x` / `team down: unexpected "x"` (each with the usage) | 2 |
| `team down: line <n>: <message>` | 2 |
| `team down: herdr doesn't answer; is it installed and running?` | 2 |
| `team down: the agents of session <session> can't be read` | 2 |
| `team down: only the owner, the coordinator or the operator stops the team; this call is <caller>` | 1 |
| `team down: only the owner abandons a team, from a terminal outside herdr` | 1 |
| `team down: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team down: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team down: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` `` | 1 |
| ``team down: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team down: <the delegate gate's text>` — the file has a `delegates` section and a delegate's call was refused: one of `down.delegate`, `down.delegate-approval`, `down.delegate-approved-copy`, `down.delegate-drift`, `down.delegate-evidence`, `down.delegate-placement`, `down.delegate-command`, `down.delegate-flag` | 1 |

## Exit codes

- `0` — the seats it could stop were stopped, the watch and the session with them; or there was
  nothing to stop; or `--dry-run` printed its plan. A seat left running because it was busy is not a
  failure.
- `1` — refused, or a step failed: a seat's exit was not typed, or was typed and not confirmed —
  the pane never drew it, its box held other text, or the clearing key did not take — its
  workspace did not close, it timed out leaving its pane, or the watch or the session did not stop.
- `2` — the invocation, the team file or herdr can't be read.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: all
watch: alive
state:
  seats:
    claude-beacon: {stage: ready, cli: claude-code}
```

Two seats idle, a watch running: this is the whole plan.

```console
$ team down --dry-run ; echo "exit $?"
+ herdr --session beacon pane run w1:p1 /exit
  wait until claude-keeper's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w1
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ kill 4242
    (the watch)
+ herdr session stop beacon
    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)
dry run: nothing was run
exit 0
```

An implementer's seat is not the coordinator's: it cannot stop the team.

```console caller=claude-beacon
$ team down ; echo "exit $?"
team down: only the owner, the coordinator or the operator stops the team; this call is claude-beacon
exit 1
```

The coordinator's own call stops the team but never its own seat, so the session stays up:

```console caller=claude-keeper
$ team down --dry-run ; echo "exit $?"
  skip claude-keeper: left running; only the owner stops the coordinator's or the operator's seat
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ kill 4242
    (the watch)
  skip session beacon: not stopped, 1 agent left in it
dry run: nothing was run
exit 0
```

The file renamed claude-beacon after `up` launched it. The seat still runs under the name it was
launched with, and the state holds the CLI it was launched with, so the plan is the same as before
the rename — only the file's copy of the name changed:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-relay
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```console
$ team down --dry-run ; echo "exit $?"
+ herdr --session beacon pane run w1:p1 /exit
  wait until claude-keeper's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w1
+ herdr --session beacon pane run w2:p1 /exit
  wait until claude-beacon's pane is back at its shell (30 s at most); on a time-out it is left as it is
+ herdr --session beacon workspace close w2
+ kill 4242
    (the watch)
+ herdr session stop beacon
    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)
dry run: nothing was run
exit 0
```

For the owner, running that plan stops everything, and clears the session it stopped — the next
`team up` starts a fresh one, with no step in between:

```console
$ team down ; echo "exit $?"
claude-keeper: stopped
claude-beacon: stopped
watch: stopped
session beacon: stopped and cleared
exit 0
```

Once the session is down there is nothing to stop, and saying so is not an error:

```console
$ team down ; echo "exit $?"
session beacon is not running: nothing to stop
exit 0
```

Even with the team file broken, `down` still reads the last copy that validated and stops the team:

```yaml file=.agents/team.yaml
format: 1
project: beacon
seats: [
```

```console
$ team down ; echo "exit $?"
team.yaml is invalid (line 3: "[" is not closed on its line); using the copy of 2026-10-04T09:00:00.000Z
session beacon is not running: nothing to stop
exit 0
```
