# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watchdog pane that runs `team watch`. Seats already ready
are left as they are; a seat stopped in the file is left out until `team add` starts it. `--dry-run`
prints the plan and runs nothing.

A session stopped in herdr is refused until its owner clears it — `up` never deletes a session. A
session `team down` stopped needs no such step: `down` clears the one it stopped in the same run, so
the next `up` starts from the beginning.

A seat that isn't `mode: shared` and works in worktrees (`workspace.mode: worktree` is the default)
starts in the lobby, never in the project root, which holds the owner's uncommitted work. The lobby
is the folder that holds the worktrees with `.lobby` beside them — the parent of `workspace.path` —
so it lies in the same `trust` as the worktrees and outside every protected checkout. `up` makes it
once, before the first such seat waits in it, and refuses when it would fall outside `trust` or
inside a protected checkout; a folder is inside one when it is inside it on disk too, symlinks
resolved. A `mode: shared` seat, and a seat the file gives a `cwd` of its own outside every
protected checkout, starts where the file says.

The lobby is a folder no CLI has seen before, and `up` reads a trust question and never answers one:
the first `up` in worktree mode leaves each implementer out with `<seat>: left out: trust question` —
its workspace closed without input, nothing run — until the owner trusts the lobby once in that CLI,
as they trusted the worktrees. Then it starts.

## Synopsis

    team up [--dry-run] [--session <name>] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store, the session's state
(`.agents/team.state.json`, for each seat's stage), herdr (whether the session is up, its agents and
workspaces), the doctor's findings, and the machine's load, free memory, free disk and free swap.
Writes `.agents/team.state.json` (each seat's stage, pane, workspace and the CLI it was launched
with; the watch's pid and heartbeat), `.agents/team.log`, the lobby folder a seat that works in
worktrees waits in, and, through herdr: the server, one workspace per seat and one for the watchdog,
each seat's launch, and the watch.

## Who may run it

The owner, from a terminal outside herdr. `--dry-run` is open to anyone: it reaches nothing and
changes nothing, prints the refusals it would hit as `! up would refuse: …` above the plan, and
exits 0.

## Flags

| Flag | Meaning |
| --- | --- |
| `--dry-run` | print the plan, and the refusals the real run would stop on, and exit 0 |
| `--session <name>` | the herdr session to start, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

    claude-keeper: ready
      skip claude-qa: stopped in the file; start it with `team add claude-qa`
    watch: started

A seat that reaches its idle prompt with its rules delivered prints `<seat>: ready`. A seat already
ready, stopped in the file, or on a CLI with no launch profile prints one `  skip` line and is left
as it is. The watch prints `watch: started`.

A message taller than its box draws is typed in parts of whole lines — its header in the first
part, its closing line in the last — each part verified to sit in the box before its own Enter,
and the next typed only once the seat is back at its idle prompt. A box that already holds
exactly the message (a run that stopped after typing it) is verified and sent, never typed onto
again. `up` never clears a box it could not verify: a stop leaves the text where it is.

A seat that doesn't get there is printed once with what stopped it, and `up` exits 1:

| Line | Meaning |
| --- | --- |
| `<seat>: left out: trust question` | the CLI asked whether to trust the folder; its workspace was closed without an answer |
| `<seat>: permission; its workspace was closed without input and the seat left out` | a permission dialog, or a question, was left for its owner to answer |
| `<seat>: timed out waiting for its idle prompt; left at launched` | the prompt never came |
| `<seat>: was not in the agent list in time; left at launched` | herdr listed no agent in the pane to name |
| `<seat>: rules not typed: <what stopped it>; <what to do>` | nothing was typed: the screen was not an empty idle prompt, the box already held text that is not the rules message, or a line of the message is taller than its box draws |
| `<seat>: rules typed, not sent: <part X of Y:>the read-back didn't match (<reading>); <what to do>` | the message was typed and its box did not read back as the message; the rules sit in its box, unsent, and `up` does not clear it. When the box drew a row that is not the message's own, the first such row is printed above this line |
| `<seat>: rules typed, not sent: <part X of Y:>its box still holds them after Enter (<reading>); <what to do>` | Enter was pressed and the box still shows the rules: the key did not take, and nothing was sent |
| `<seat>: <parts 1-N of M were sent; ><part X of Y:>the seat did not come back to its idle prompt (<reading>); <what to do>` | a part was submitted and the seat never came back to its idle prompt — a running turn, or a dialog to answer |
| `<seat>: its rules were not delivered; left at named` | the pane could not be read at all; nothing was typed |
| `<seat>: its workspace was not created; left at launched` | herdr made no workspace for it |
| `<seat>: its lobby folder was not created; left out` | the folder a seat that works in worktrees waits in could not be made |
| `<seat>: its launch command did not run; left at launched` | the pane took no command |
| `<seat>: the approval allows 3 seats; 4 would be running` | the approval's ceiling, from the record, not the file |
| `<seat>: refused: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | a counted reading is inside that account's reserve and this run would launch the seat; this seat is not started, and the others still are. `accounts with room: none` when no other account has room |
| `<seat>: refused: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | the money its check counted is at or below the account's floor, and this run would launch the seat; this seat is not started, and the others still are |
| `<seat>: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | the same reading, and the seat is already running; setup continues and the line is only a notice |
| `<seat>: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | the same money reading, and the seat is already running; setup continues and the line is only a notice |
| `<seat>: <account> is unknown` | the account is in the file and its figure is unknown — a subscription with no counted reading, or a spend account whose money reading is missing, older than `budgets.stale_after`, or in another currency than the floor's. A subscription figure with no known reset is unknown while it could still matter — inside its reserve, or within the reserve again outside it; further out — more than the reserve again — it counts, the room the figure last held, and the launch decision is clear: no unknown line. The seat still starts |
| `<seat>: <account>: first sight only, not yet counted` | the account's only readings are unconfirmed; the seat still starts |

`<account>` in these lines is the seat's own account: its `account:` when the file names one, its
`vendor` when it doesn't.

The plan a `--dry-run` prints is also what `team down --dry-run` prints: `+ <command>` for a command
that would run, a `    (<note>)` line under one that carries a note, `  wait <text>` for a wait,
`  skip <text>` for a seat left out, and `dry run: nothing was run` at the end. A seat a stored
reading would refuse, and that this run would launch, is `  skip <seat>: would refuse: …` and is not
in the commands. The words after `would refuse:` are the same as the words after `refused:`. A seat
already running keeps its setup, with that reading in a note. A seat whose account is unknown
carries `(<account> is unknown; would launch)` under its first command. A first sight carries
`(<account>: first sight only, not yet counted; would launch)`. A launch carries the seat's rules,
so its line is long. Rules delivered as a launch option (claude-code) close with `These are standing
rules, not a task.`; rules typed as a first message (codex, cursor and antigravity) close with
`These are standing rules, not a task: reply ready and wait for your brief.`

## Refusals

A real run stops before the first step, prints one `team up: <reason>` per reason and exits 1:

| Reason |
| --- |
| ``only the owner runs `up`, from a terminal outside herdr; this call is <caller>`` |
| ``the file was never approved on this machine: run `team approve` `` |
| ``approved before records were signed: run `team approve` once`` — the record was written by an earlier `team` |
| ``the record <case>: run `team approve` once`` — a signed record that does not verify |
| ``the file is not the approved one (<differences>): run `team approve` `` |
| a `MISS` finding from [team doctor](doctor.md) — herdr or a CLI not installed, a CLI not logged in, a launch naming another model than the file |
| `the load is 1.2 per core, above 1` / `free memory is 8%, below 25%` / `free disk is 3.0 GB, below 10.0 GB` / `free swap is 1.0 GB, below 2.0 GB` |
| `herdr doesn't answer` |
| ``session beacon is stopped; clear it with `herdr session delete beacon` `` |
| ``session beacon has 2 agents this file's state doesn't record: `up` never touches a running team`` |
| ``the lobby ../worktrees/beacon/.lobby matches no trust pattern (., ../worktrees/beacon/task): add one that covers it and run `team approve` `` |
| ``seat beacon-qa would start in live, inside the protected checkout live; a seat that isn't `mode: shared` never starts in one`` — the folder the file gives it, or its lobby, is a protected checkout |

A watch that has not run, or whose heartbeat is old, is not a reason to refuse: `up` starts the
watch itself.

## Exit codes

- `0` — every seat is ready and the watch is running; or `--dry-run` printed its plan.
- `1` — the run was refused, or a seat was left out, or the server or the watch failed.
- `2` — the invocation or the team file can't be read.

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

  - role: reviewer
    name: claude-qa
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
```

```fixture
agents: [claude-keeper, claude-beacon]
watch: none
state:
  seats:
    claude-keeper: {stage: ready}
    claude-beacon: {stage: ready}
```

Two seats are up and the third is stopped in the file, so the plan is short — the skipped seats, and
the watchdog pane this session has never had:

```console
$ team up --dry-run ; echo "exit $?"
  skip claude-keeper: already ready; left as it is
  skip claude-beacon: already ready; left as it is
  skip claude-qa: stopped in the file; start it with `team add claude-qa`
+ herdr --session beacon workspace create --cwd . --label watchdog --no-focus
+ herdr --session beacon pane run <pane of watchdog> 'team watch --session beacon'
    (a desktop notification follows when the watch exits)
dry run: nothing was run
exit 0
```

The same command for real runs exactly that:

```console
$ team up ; echo "exit $?"
  skip claude-keeper: already ready; left as it is
  skip claude-beacon: already ready; left as it is
  skip claude-qa: stopped in the file; start it with `team add claude-qa`
watch: started
exit 0
```

A seat is not the owner, so it can read a plan but not start a team:

```console caller=claude-beacon
$ team up ; echo "exit $?"
team up: only the owner runs `up`, from a terminal outside herdr; this call is claude-beacon
exit 1
```

A session stopped in herdr is never started over — `up` deletes nothing, and its refusal says the
command to run by hand. A session `team down` stopped never gets here: `down` clears the one it
stopped in the same run, so the next `up` finds no session and starts it from the beginning:

```console herdr=stopped
$ team up ; echo "exit $?"
team up: session beacon is stopped; clear it with `herdr session delete beacon`
exit 1
```

An owner section changed in the file needs a new approval, and the plan says so before the run:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

limits:
  seats: 4

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

  - role: reviewer
    name: claude-qa
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
```

```console
$ team up --dry-run ; echo "exit $?"
! up would refuse: the file is not the approved one (`limits` changed): run `team approve`
! up would refuse: run `team approve`: `limits` changed
  skip claude-keeper: already ready; left as it is
  skip claude-beacon: already ready; left as it is
  skip claude-qa: stopped in the file; start it with `team add claude-qa`
dry run: nothing was run
exit 0
```

The real run goes no further than the refusal — it never touches a team the file doesn't match:

```console
$ team up ; echo "exit $?"
team up: the file is not the approved one (`limits` changed): run `team approve`
team up: run `team approve`: `limits` changed
exit 1
```
