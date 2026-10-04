# team add

Starts one seat of a running team: a seat the file declares but nothing runs for — `team up` started
the others — or a temporary seat beside the team, which the file does not declare at all. A declared
seat the file marks `stopped: true`, or that `team remove` took out, is put back from the approved
copy first. It never touches the seats that are already running.

The one seat starts where `up` would start it: a seat that isn't `mode: shared` and works in
worktrees waits in the lobby — the parent of `workspace.path` with `.lobby` beside the worktrees,
inside `trust` and outside every protected checkout — unless the file gives it a `cwd` of its own,
or `--worktree` names the worktree it works in. `add` makes the lobby when it needs it, and refuses
the same folders `up` refuses, before it writes anything.

## Synopsis

    team add <name> [--session <name>] [--file <path>]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>]
             [--session <name>] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store (the record, and the
approved copy the seat is put back from), the session's state (`.agents/team.state.json`), herdr (the
session's state, its agents and their workspaces), and, like `up`: the doctor's findings and the
machine's load, free memory, free disk and free swap.

Writes the team file when the seat has to be put back into it, `.agents/team.state.json` (the seat's
stage, pane and workspace; a temporary seat's entry), `.agents/team.log`, the store's ledger of
seats the team has had, and, through herdr: the workspace, the launch, and the name.

## Who may run it

The owner, the coordinator's seat and the operator's seat. `--file` is the owner's alone, from a
terminal outside herdr. Everything `up` refuses on — a file that is not the approved one, a `MISS`
finding from [team doctor](doctor.md), the machine past its limits, the approval's ceilings — refuses
here too, for the one seat being started.

## Flags

| Flag | Meaning |
| --- | --- |
| `--temporary` | start a seat the file does not declare, beside the team |
| `--like <seat>` | the approved seat a temporary seat is a copy of: its CLI, model and launch |
| `--until <end>` | what the temporary seat works for: `result:<path>` (a file it writes, relative to the project) or `merged:<branch>` (a branch merged into the base) |
| `--worktree <task>` | the worktree the temporary seat is started in, instead of the seat's own `cwd` |
| `--session <name>` | the herdr session, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | the usage, and exit 0 |

The temporary seat's name is the `--like` seat's, with `-tmp-<n>`: the first `n` that is free.

## What it prints

    claude-keeper: ready

A seat that reaches its idle prompt with its rules delivered prints `<seat>: ready`; the temporary
seat prints `<name>: ready` under the name it was given. Everything else a launch can print is the
same as `up`'s, with the seat's name in front: `its workspace was not created; left at launched`,
`timed out waiting for its idle prompt; left at launched`, `permission; its workspace was closed
without input and the seat left out`, and the rest of the table on the [team up](up.md) page.

## Refusals

| Message | Exit |
| --- | --- |
| `team add: unknown option --x` / `team add: a seat name is required` / `team add: --like needs a value` (each with the usage) | 2 |
| `team add: --like, --until and --worktree are for --temporary` | 2 |
| `team add: line <n>: <message>` / `team add: <message>` | 2 |
| `team add: only the owner, the coordinator or the operator runs it; this call is <caller>` | 1 |
| `team add: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team add: the file was never approved on this machine: run `team approve` `` | 1 |
| ``team add: the file is not the approved one (<differences>): run `team approve` `` | 1 |
| ``team add: the approved copy can't be read: run `team approve` `` | 1 |
| `team add: the approved file has no seat "<name>"` | 1 |
| `team add: <name> is already running` | 1 |
| `team add: no launch profile for \`<cli>\` in this version` | 1 |
| `team add: the approval allows <n> seats; <m> would be running` / `… <n> temporary seats; …` / `… <n> <vendor> seats; …` | 1 |
| `team add: session can't be "default", herdr's own session` | 1 |
| `team add: herdr doesn't answer` | 1 |
| ``team add: session <session> is stopped; clear it with `herdr session delete <session>` `` | 1 |
| `team add: session <session> runs, and its agents can't be read` | 1 |
| `team add: --until is result:<path> or merged:<branch>` | 1 |
| `team add: a result path is relative to the project` / `team add: <path> already exists` | 1 |
| `team add: workspace.base is required to read a merged end` / `team add: branch <branch> doesn't exist` | 1 |
| `team add: no worktree named "<task>" is recorded` | 1 |
| `team add: worktree <task> has a failed setup; team worktree remove <task>` | 1 |
| ``team add: the lobby ../worktrees/beacon/.lobby matches no trust pattern (., ../worktrees/beacon/task): add one that covers it and run `team approve` `` | 1 |
| ``team add: seat beacon-qa would start in live, inside the protected checkout live; a seat that isn't `mode: shared` never starts in one`` | 1 |
| `team add: the file changed while add was checking; nothing was written` | 1 |
| `team add: the load is <n> per core, above <n>` / `team add: free memory is <n>%, below <n>%` | 1 |
| a `MISS` finding from [team doctor](doctor.md) | 1 |

The ceilings are read from the approval's record, never from the file: a seat that would put the
session past `limits.seats`, past `limits.temporary` for a temporary seat, or past a
`limits.vendors` entry for its vendor, is refused.

## Exit codes

- `0` — the seat reached its idle prompt and is ready; or the temporary seat is.
- `1` — the run was refused, or the seat was left behind at some stage of its launch.
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
```

```fixture
agents: [claude-beacon]
```

Only the implementer is up. The coordinator's seat is in the file and nothing runs for it, which is
`team status`'s `missing` and the repair it names:

```console
$ team add claude-keeper ; echo "exit $?"
claude-keeper: ready
exit 0
```

The seat that is already running is never touched, and adding it is refused:

```console
$ team add claude-beacon ; echo "exit $?"
team add: claude-beacon is already running
exit 1
```

An implementer's seat is neither the coordinator's nor the operator's, so it adds nothing — not even
itself:

```console caller=claude-beacon
$ team add claude-keeper ; echo "exit $?"
team add: only the owner, the coordinator or the operator runs it; this call is claude-beacon
exit 1
```

`team remove --keep` leaves a seat in the file marked stopped, and `add` is what clears the mark and
starts it again:

```console
$ team remove claude-beacon --keep ; echo "exit $?"
claude-beacon: stopped
stopped claude-beacon
exit 0
$ team add claude-beacon ; echo "exit $?"
claude-beacon: ready
exit 0
```

A temporary seat is not in the file at all. It is a copy of an approved seat — here the implementer's
— and it works until a result exists or a branch is merged:

```console
$ team add --temporary --like claude-beacon --until result:notes/result.md ; echo "exit $?"
claude-beacon-tmp-1: ready
exit 0
```

The seat's name must be one the approved file has, so a name that is not is refused before herdr is
asked anything:

```console
$ team add scratch ; echo "exit $?"
team add: the approved file has no seat "scratch"
exit 1
$ team add --temporary --like claude-beacon --until later ; echo "exit $?"
team add: --until is result:<path> or merged:<branch>
exit 1
```

The flags that describe a temporary seat are refused without `--temporary`, and a name is required
outside it. Both stop at the usage line, before the file is read:

```console
$ team add claude-keeper --like claude-beacon ; echo "exit $?"
team add: --like, --until and --worktree are for --temporary
exit 2
$ team add ; echo "exit $?"
team add: a seat name is required
Usage: team add <name> [--session <name>] [--file <path>]
       team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--session <name>] [--file <path>]
exit 2
```
