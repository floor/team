# team remove

Takes one seat out of the team: asks it to exit, waits for its pane to come back to its shell,
closes its workspace, and edits the file so the seat is not started again. `--keep` leaves the seat
in the file as `stopped: true` instead of taking it out. A seat that is busy — working, blocked at a
prompt, showing a screen the profile does not recognise, or holding unsent text — is left as it is,
unless its owner abandons it. Every other seat, and the session, are left alone.

## Synopsis

    team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]

## What it reads and writes

Reads the team file, the session's state (`.agents/team.state.json`, for a temporary seat's record),
herdr: whether the session runs, its agents, each pane's screen and status, and the pane's
foreground processes, which is how it knows the CLI has really exited, and the approval store:
stopping a seat and editing the file are changes the owner approves first. Without an approval in
force — never approved, a record from before records were signed, or one the verification refused —
nothing is stopped and nothing is written, with the one-line repair every command prints.

Writes the team file (the seat's entry taken out, or `stopped: true` added to it),
`.agents/team.state.json` (the seat's record is dropped), `.agents/team.log`, and, through herdr:
the exit typed into the pane, the wait for its shell, and the workspace closed. A temporary seat's
rules file goes with it, out of the project state folder; a seat left in the file as stopped keeps
its file for the next `up`. A file edit that
would not validate is refused before the seat is stopped, so a broken file never costs a live seat.

## Who may run it

The owner, the coordinator's seat and the operator's seat. The seat is that name's, in a session
this project's state records — the file's session, or one the state records the caller's pane in —
on the pane the state records for that name in that session: a seat of another session, or a pane
merely renamed to the coordinator's or the operator's name, is refused — and so is a seat the state
records no pane for, or records on another pane than this call is on; those two refusals name the
seat and the repair. What that proves is placement, and no more: the state file is in the project,
and a process of the same user that writes its own pane there under the coordinator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the
same user.
The
coordinator's and the operator's own seats are the owner's alone to remove, and so is `--abandon`.
`--file` and `--session` are the owner's alone, from a terminal outside herdr: a non-owner aiming
either is refused before the flagged file or session is read at all.

## Flags

| Flag | Meaning |
| --- | --- |
| `--keep` | leave the seat in the file with `stopped: true`: `team up` leaves it out, and `team add <name>` starts it again |
| `--abandon` | the owner's: close the workspace of a seat that can't be asked, typing nothing into it |
| `--session <name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

    claude-beacon: stopped
    removed claude-beacon

The seat's stop is the plan `down` prints for a seat, with its notes; the last line says what was
done with the file:

| Last line | Meaning |
| --- | --- |
| `removed <name>` | the seat's entry was taken out of the file |
| `stopped <name>` | `--keep`: the entry stays, with `stopped: true` |
| `removed temporary <name>` | a temporary seat: it was never in the file |

A seat that doesn't leave cleanly is printed once with what stopped it, and `remove` exits 1:
`<seat>: its exit was not typed; left as it is`, `<seat>: timed out leaving its pane; left as it is`,
`<seat>: its workspace did not close`. The file is then not edited: the seat is still in the team.

## Refusals

| Message | Exit |
| --- | --- |
| `team remove: unknown option --x` / `team remove: a seat name is required` / `team remove: unexpected "x"` (each with the usage) | 2 |
| `team remove: line <n>: <message>` | 2 |
| `team remove: only the owner, the coordinator or the operator runs it; this call is <caller>` | 1 |
| `team remove: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team remove: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| ``team remove: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` `` | 1 |
| ``team remove: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team remove: only the owner abandons a seat, from a terminal outside herdr` | 1 |
| `team remove: only the owner removes the coordinator's or the operator's seat; this call is <caller>` | 1 |
| `team remove: session can't be "default", herdr's own session` | 1 |
| `team remove: the team has no seat "<name>"` | 1 |
| `team remove: a temporary seat is not in the file; there is nothing to keep` | 1 |
| `team remove: herdr doesn't answer; nothing was changed` | 1 |
| `team remove: session <session> runs, and its agents can't be read; nothing was changed` | 1 |
| `team remove: <seat> is working; left as it is` | 1 |
| `team remove: <seat> is blocked at a prompt, which team never answers` | 1 |
| `team remove: <seat> shows a screen the profile does not recognise; left as it is (team remove <seat> --abandon closes its workspace without typing)` (the owner) or `… left as it is (the owner can close it: team remove <seat> --abandon)` (a coordinator or the operator) | 1 |
| `team remove: <seat> holds unsent text in its input box; left as it is` | 1 |
| ``team remove: no launch profile for `<cli>`; left as it is`` | 1 |
| ``team remove: the file was never approved on this machine: run `team approve` `` | 1 |
| ``team remove: approved before records were signed: run `team approve` once`` — the record was written by an earlier `team`; the same line, with the case, for a record that does not verify | 1 |

`--abandon` answers the last five: the seat is not asked anything, its workspace is closed as it is,
and its pane's text is lost.

## Exit codes

- `0` — the seat was stopped or was not running, and the file was edited.
- `1` — the run was refused, or the seat was left behind with the file untouched.
- `2` — the invocation, the team file or the state can't be read, or the edit would not validate.

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
```

A seat mid-turn is not interrupted — its work would be lost — and `remove` says which state it was
in:

```console screens="claude-beacon=working"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon is working; left as it is
exit 1
```

A permission prompt is the same: `team` never answers one, so it never closes a seat that waits at
one.

```console screens="claude-beacon=permission"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon is blocked at a prompt, which team never answers
exit 1
```

A screen the profile can't read never frees itself, and only the owner may abandon it, so the
refusal names that way out — the command itself for the owner, whose it is for anyone else:

```console screens="claude-beacon=unknown"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon shows a screen the profile does not recognise; left as it is (team remove claude-beacon --abandon closes its workspace without typing)
exit 1
```

```console caller=claude-keeper screens="claude-beacon=unknown"
$ team remove claude-beacon ; echo "exit $?"
team remove: claude-beacon shows a screen the profile does not recognise; left as it is (the owner can close it: team remove claude-beacon --abandon)
exit 1
```

An implementer's seat may not remove anything — not even itself:

```console caller=claude-beacon
$ team remove claude-beacon ; echo "exit $?"
team remove: only the owner, the coordinator or the operator runs it; this call is claude-beacon
exit 1
```

The coordinator's seat may remove others, never itself, and `--abandon` is the owner's own, from a
terminal outside herdr:

```console caller=claude-keeper
$ team remove claude-keeper ; echo "exit $?"
team remove: only the owner removes the coordinator's or the operator's seat; this call is claude-keeper
exit 1
$ team remove claude-beacon --abandon ; echo "exit $?"
team remove: only the owner abandons a seat, from a terminal outside herdr
exit 1
```

A temporary seat is recorded in the state, not in the file, so it is removed by the name `add` gave
it — and `--keep` has nothing to keep. It comes before the seats the file declares change: taking a
seat out of the file moves the `limits` the file defaults to, and `add --temporary` refuses a file
that is no longer the approved one.

```console
$ team add --temporary --like claude-beacon --until result:notes/result.md ; echo "exit $?"
claude-beacon-tmp-1: ready
exit 0
$ team remove claude-beacon-tmp-1 --keep ; echo "exit $?"
team remove: a temporary seat is not in the file; there is nothing to keep
exit 1
$ team remove claude-beacon-tmp-1 ; echo "exit $?"
claude-beacon-tmp-1: stopped
removed temporary claude-beacon-tmp-1
exit 0
```

`--keep` stops the seat and leaves its place in the file, for a seat that will come back:

```console
$ team remove claude-beacon --keep ; echo "exit $?"
claude-beacon: stopped
stopped claude-beacon
exit 0
$ team add claude-beacon ; echo "exit $?"
claude-beacon: ready
exit 0
```

Without `--keep` the seat's entry goes with it, and a second `remove` has nothing to find:

```console
$ team remove claude-beacon ; echo "exit $?"
claude-beacon: stopped
removed claude-beacon
exit 0
$ team remove claude-beacon ; echo "exit $?"
team remove: the team has no seat "claude-beacon"
exit 1
```

A name is required, and its absence stops at the usage line before the file is read:

```console
$ team remove ; echo "exit $?"
team remove: a seat name is required
Usage: team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]
exit 2
```
