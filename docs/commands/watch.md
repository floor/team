# team watch

Watches a running team. Every `watch.interval` seconds it reads the session — the seats, their
screens, the file, the approval, the machine — prints what is wrong, and closes a temporary seat or
a merged worktree whose end holds. When a seat asks a question, or goes idle, it types one fixed
line into the operator's pane — the nudge — so the operator reads its log. It types nothing into a
screen it can't read as an empty idle prompt, so a permission dialog and a half-typed sentence are
left alone.

## Synopsis

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

## What it reads and writes

Reads the team file — again on every pass, so a seat parked or stopped since is seen — this
machine's approval store, the session's state (`.agents/team.state.json`) and herdr: the session's
agents, each pane's screen and status. It also reads the machine's load, free memory, free disk and
swap, and, when a temporary seat's end is judged, git.

Writes `.agents/team.state.json` (the watch's pid and a heartbeat, once a pass; a temporary seat's
`worked` and `own_commits` when it sees them), `.agents/team.log` (every line it prints), and,
through herdr: the nudge's text and Enter, and the panes and workspaces of the seats it closes.

## Who may run it

Anyone, in any terminal. `up` starts one for the session in a pane of its own, and this is the one
`team status` and `team doctor` look for. A person may run one by hand: it prints the same lines,
and Ctrl-C stops it and exits 0. Two watches must not fight over the same session, so a second one
refuses.

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session to watch, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--no-nudge` | never type into the operator's pane; the reports still go to the log and the desktop |
| `--no-notify` | no desktop notifications; the nudge is still typed and the log still written |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

Every line carries its time, and every line goes to `.agents/team.log` as well:

    2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
    2026-10-04T09:00:00.000Z claude-beacon asked a question: the operator's to act on
    2026-10-04T09:00:00.000Z nudged the operator: Team watch: reports are waiting in .agents/team.log
    2026-10-04T09:00:00.000Z the watch of "beacon" stopped

A report is printed when it starts, and again only after it has cleared: a seat that stays blocked,
or a machine that stays full, is said once, not every pass.

| Report | Made when |
| --- | --- |
| `<seat> is in the file and is not running` | herdr lists no agent for a seat the file has and does not stop |
| `<seat> waits at a permission prompt: its owner's to answer` | a permission dialog or a trust question; only its owner answers those |
| `<seat> asked a question: the operator's to act on` | a question the seat is waiting on |
| `<seat> is blocked, and its screen is not one the watch recognises` | herdr says blocked and the screen says nothing the watch knows |
| `<seat>: herdr reports the status "<status>"` | a status that is neither idle, done, working nor blocked |
| `<seat> holds text in its input box that was never sent` | unsent text for `watch.unsent_after` |
| `<seat> has been idle since the watch started` | quiet for `watch.idle_first`, and never seen working |
| `<seat> has been idle for <n> minutes` | quiet for `watch.idle_first` since its last turn, then every `watch.idle_repeat` |
| `every agent is idle` | every seat that is not the coordinator, the operator or parked, quiet for `watch.team_idle` |
| `<seat> runs <model> <version>; the file says <model> <version>: it signs with the wrong model` | the running model or version is not the file's |
| `<name> (<pane>) is running and is not in the file` | an agent in the session no seat claims, the watchdog pane aside |
| `the file was never approved on this machine` | there is no approval record for this project |
| `the file differs from the approved one: <differences>` | the file is not the approved one; the differences read as `team status` prints them |
| `the load is <n> per core, above <n>` | over `machine.load_max` |
| `free memory is <n>%, below <n>%` | under `machine.memory_min` |
| `free disk is <n> GB, below <n> GB` | under `machine.disk_min` |
| `free swap is <n> GB, below <n> GB` | under `machine.swap_free_min` |
| `swap grew by <n> GB in <n> minutes, above <n> GB` | over `machine.swap_growth_max` inside `machine.swap_growth_window` |

A report that is the operator's to act on is also what the nudge stands for. The lines around it:

| Line | Made when |
| --- | --- |
| `watching the session "<session>" every <n>s` | at the start; `, without nudges` is added by `--no-nudge` |
| `nudged the operator: Team watch: reports are waiting in .agents/team.log` | the nudge was typed and sent |
| `nudge not typed (--no-nudge): <nudge>` | `--no-nudge`, with reports waiting |
| `a nudge was typed and not sent: the operator's screen changed before the Enter` | a dialog opened between the typing and the Enter; the reports wait for the next pass |
| `the operator could not be nudged for <n> minutes; <k> report(s) wait: <reports>` | the operator was busy for `watch.nudge_wait`; this one is a desktop notification too |
| `herdr doesn't answer; the watch keeps trying` | the pass is skipped and the watch goes on |
| `team.yaml can't be read (<problem>); watching with the team as it was` | the file broke and no copy of it validated |
| `closed <seat>; its end <until> holds` | a temporary seat whose end is proved and whose pane is free was stopped |
| `worktree <task> was not removed` | its removal failed; it is tried again on the next pass |
| `the watch of "<session>" stopped` | the last line, on Ctrl-C or a stop signal |

## Refusals

| Message | Exit |
| --- | --- |
| `team watch: a watch already runs for the session "<session>" (pid <pid>)` | 1 |
| `team watch: unknown option --x` / `team watch: unexpected "x"` (each with the usage) | 2 |
| `team watch: team.yaml line <n>: <message>` / `team watch: <message>` | 2 |

## Exit codes

- `0` — the watch ran, and stopped on Ctrl-C, a stop signal, or the end of its work. A seat that
  misbehaves is a report, not a failure; neither is herdr not answering.
- `1` — a watch already runs for the session.
- `2` — the invocation, the team file or the state can't be read.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

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
watch: none
```

Two seats at their prompts, nothing to report: a pass is the two lines that frame it.

```console
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

A question is the operator's to act on, so the watch nudges the operator — one fixed line, which is
not the report itself: the report is in the log, and the line says where.

```console screens="claude-beacon=question"
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z claude-beacon asked a question: the operator's to act on
2026-10-04T09:00:00.000Z nudged the operator: Team watch: reports are waiting in .agents/team.log
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

A permission prompt is the owner's, and the watch says so rather than nudging anyone:

```console screens="claude-beacon=permission"
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z claude-beacon waits at a permission prompt: its owner's to answer
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

`--no-nudge` keeps the reports and skips the typing — for a watch whose operator is not to be
interrupted at all:

```console screens="claude-beacon=question"
$ team watch --no-nudge ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s, without nudges
2026-10-04T09:00:00.000Z claude-beacon asked a question: the operator's to act on
2026-10-04T09:00:00.000Z nudge not typed (--no-nudge): Team watch: reports are waiting in .agents/team.log
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The machine is watched the same way. Free memory under `machine.memory_min` is the owner's to
answer, and a watch does not stop the team over it:

```console machine=tight
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z free memory is 8%, below 15%
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

A file that no longer validates is not a reason to stop watching: the last copy that did is used,
with a notice, and the watch goes on.

```yaml file=.agents/team.yaml
format: 1
project: beacon
seats: [
```

```console
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z team.yaml is invalid (line 3: "[" is not closed on its line); using the copy of 2026-10-04T09:00:00.000Z
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The file is part of the same pass. A `trust` line changed since the owner approved it is reported at
the next one, and the team keeps running until the owner approves it again:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - .

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

```console
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the file differs from the approved one: `trust` changed
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The watch's own timings are the owner's too: `interval`, `idle_first`, `idle_repeat`, `team_idle`,
`nudge_wait` and `unsent_after` are approved with the file, and an edit to one of them changes
nothing until the owner approves it — the passes keep running with the values of the approved copy,
or with the defaults when nothing was approved, and the difference is reported.

A check the team doesn't want is turned off in `watch.checks` — a section only the owner changes,
so it is approved like the rest of them. The machine below sits at 8% free memory, and this file
turns that one report off — but the edit is not approved yet, so nothing is turned off: the report
still comes, with the difference beside it.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

watch:
  interval: 120s
  checks:
    memory: off

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

```console machine=tight
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the file differs from the approved one: `watch.checks` changed
2026-10-04T09:00:00.000Z free memory is 8%, below 15%
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

The owner approves it, and the next pass runs without the check:

```console
$ team approve ; echo "exit $?"
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 6: watch:
  + 7:   interval: 120s
  + 8:   checks:
  + 9:     memory: off
  + 10: 

Needs a new approval: `watch.checks` changed.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).

Type the number of seats (2) to approve this file, and its commands and rules, to run: 2
Approved. The record is in ~/.config/team/beacon-<hash>; check the rest with `team doctor`.
exit 0
```

```console machine=tight
$ team watch ; echo "exit $?"
2026-10-04T09:00:00.000Z watching the session "beacon" every 120s
2026-10-04T09:00:00.000Z the watch of "beacon" stopped
exit 0
```

`up` leaves a watch running in its own pane, so a second one refuses rather than reading the same
session twice:

```console
$ team up ; echo "exit $?"
  skip claude-keeper: already ready; left as it is
  skip claude-beacon: already ready; left as it is
watch: started
exit 0
$ team watch ; echo "exit $?"
team watch: a watch already runs for the session "beacon" (pid 4242)
exit 1
```

The four that can't be turned off — `attention`, `missing`, `model-drift` and `approval` — are
refused by the schema itself, with the line, and so is a name that is no check. `team approve`
refuses such a file the same way, and the watch keeps the last copy that validated, with the
checks as the owner approved them.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

watch:
  interval: 120s
  checks:
    attention: off
    disks: off

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

```console
$ team approve ; echo "exit $?"
team approve: line 9: watch.checks can't turn off attention: attention, missing, model-drift, approval always run
team approve: line 10: unknown check "disks" in watch.checks: the checks are missing, model-drift, attention, unsent, idle, extra, team-idle, approval, load, memory, disk, swap-free, swap-growth
exit 2
```
