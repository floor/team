# team approve

The owner approves the team file: reads it, shows what changed since the last approval, asks for the
number of seats, and writes the record this machine holds it to. Every command that starts, moves or
changes a team checks that record first, so an edit to the file needs a new approval before it can
run. `--show` prints the same comparison and stops, writing nothing.

## Synopsis

    team approve [--show] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), its validation, and, when there is one, the approved
copy this machine holds. Writes the approval record and the ledger of every seat the team has had
here — both in the store, `~/.config/team/<project>-<hash>` — and one line in `.agents/team.log`.
`--show` writes nothing.

## Who may run it

The owner, from a terminal outside herdr: no seat approves a file, not even the coordinator's.
`--show` may be run by anyone, in any terminal.

## Flags

| Flag | Meaning |
| --- | --- |
| `--show` | print the comparison, ceilings and seats, and stop; change nothing |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

With no record on this machine, the whole file, numbered, so the owner reads exactly what is being
approved. With a record, a line per changed section or seat against the approved copy:

    + 6: trust:
    + 7:   - .

    Needs a new approval: `trust` changed.

Nothing at all changed is said plainly:

    ./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

    Nothing in it needs a new approval.

Then the ceilings the approval would fix — `3 seats at most, 2 temporary` — and the
seat names, and then the question. The seat ceiling defaults to the seats the file declares plus the
temporary ones, so adding a seat widens it, and that shows up as `limits` changed too. What needs a
new approval is a change to an owner section
(`trust`, `limits`, `machine`, `rules`, `identity`, `workspace`, `coordinator`, `operator`,
`session`, `visibility`, `tools`, `budgets`, `watch` — its timings included, down to `watch.checks`,
whose turn-offs are their own line) or to a seat's own fields; a seat taken out, parked or stopped
does not, so `remove --keep` and `add` never send the owner back to `approve`. Until an edit is
approved its section changes nothing: the watch, the budget reports, the check cadence, `up`'s and
`add`'s launch gate and `status`'s table run with the approved values, or with the defaults when
nothing was approved. A stored copy that no longer validates: the defaults run, and the difference
is reported until the next approve.

## Refusals

| Message | Exit |
| --- | --- |
| `team approve: unexpected "x"` (with the usage) | 2 |
| `team approve: line <n>: <message>` / `team approve: <message>` | 2 |
| `team approve: the approval store <store> is inside <folder>, where seats work` | 1 |
| `team approve: only the owner approves a team file, from a terminal outside herdr; this call is <caller>` | 1 |
| `team approve: not approved; nothing was written` | 1 |

A file that loads with warnings prints them on stderr as
`team approve: warning, line <n>: <message>` and goes on. The last refusal is what an answer that is
not the number of seats gets: a blank answer, a wrong one, and a closed terminal are all the same
answer.

## Exit codes

- `0` — approved, or `--show` printed the comparison and stopped before the question.
- `1` — refused: a seat ran it, the store sits where seats work, or the answer was not the number of
  seats. Nothing is written.
- `2` — the invocation, the team file or the file's validation is bad.

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
```

```fixture
approved: false
```

The first run shows the whole file, because this machine has no copy of it to compare against:

```console
$ team approve --show ; echo "exit $?"
./.agents/team.yaml: never approved on this machine. The whole file:

  1: format: 1
  2: project: beacon
  3: coordinator: claude-keeper
  4: operator: claude-keeper
  5: 
  6: workspace:
  7:   mode: shared
  8: 
  9: seats:
  10:   - role: coordinator
  11:     name: claude-keeper
  12:     label: coordinator
  13:     cli: claude-code
  14:     vendor: anthropic
  15:     model: Claude Opus
  16:     version: "5.5"
  17:     launch: claude --model claude-opus-5-5

Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
exit 0
```

The owner approves it, typing the number of seats:

```console
$ team approve
./.agents/team.yaml: never approved on this machine. The whole file:

  1: format: 1
  2: project: beacon
  3: coordinator: claude-keeper
  4: operator: claude-keeper
  5: 
  6: workspace:
  7:   mode: shared
  8: 
  9: seats:
  10:   - role: coordinator
  11:     name: claude-keeper
  12:     label: coordinator
  13:     cli: claude-code
  14:     vendor: anthropic
  15:     model: Claude Opus
  16:     version: "5.5"
  17:     launch: claude --model claude-opus-5-5

Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).

Type the number of seats (1) to approve this file, and its commands and rules, to run: 1
Approved. The record is in ~/.config/team/beacon-<hash>; check the rest with `team doctor`.
```

A seat can read the comparison — even the coordinator's — but a seat is not the owner, and nothing is
written for it:

```console caller=claude-keeper
$ team approve ; echo "exit $?"
./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

Nothing in it needs a new approval.
Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
team approve: only the owner approves a team file, from a terminal outside herdr; this call is claude-keeper
exit 1
```

An owner section is the owner's to change, and the comparison says so before the question:

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
```

```console
$ team approve --show ; echo "exit $?"
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 6: trust:
  + 7:   - .

Needs a new approval: `trust` changed.
Ceilings this approval fixes: 3 seats at most, 2 temporary.
Seats: 1 (claude-keeper).
exit 0
```

A new seat needs one too — a seat already approved may be parked, stopped or taken out without
bothering the owner, but a seat the file never had is not:

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

```console answer="1"
$ team approve ; echo "exit $?"
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 6: trust:
  + 7:   - .
  + 20:   - role: implementer
  + 21:     name: claude-beacon
  + 22:     label: implementer
  + 23:     cli: claude-code
  + 24:     vendor: anthropic
  + 25:     model: Claude Opus
  + 26:     version: "5.5"
  + 27:     launch: claude --model claude-opus-5-5

Needs a new approval: `trust` changed; `limits` changed; seat claude-beacon is not in the approved file.
Ceilings approved: 3 seats at most, 2 temporary.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).

Type the number of seats (2) to approve this file, and its commands and rules, to run: 1
team approve: not approved; nothing was written
exit 1
```

The answer is the number of seats, and nothing else — here, two:

```console answer="2"
$ team approve
./.agents/team.yaml: against the copy approved on 2026-10-04T09:00:00.000Z:

  + 6: trust:
  + 7:   - .
  + 20:   - role: implementer
  + 21:     name: claude-beacon
  + 22:     label: implementer
  + 23:     cli: claude-code
  + 24:     vendor: anthropic
  + 25:     model: Claude Opus
  + 26:     version: "5.5"
  + 27:     launch: claude --model claude-opus-5-5

Needs a new approval: `trust` changed; `limits` changed; seat claude-beacon is not in the approved file.
Ceilings approved: 3 seats at most, 2 temporary.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).

Type the number of seats (2) to approve this file, and its commands and rules, to run: 2
Approved. The record is in ~/.config/team/beacon-<hash>; check the rest with `team doctor`.
```

The same file again is the same text as the approved copy, and the approval stands:

```console
$ team approve --show ; echo "exit $?"
./.agents/team.yaml: the same text as the copy approved on 2026-10-04T09:00:00.000Z.

Nothing in it needs a new approval.
Ceilings this approval fixes: 4 seats at most, 2 temporary.
Seats: 2 (claude-keeper, claude-beacon).
exit 0
```
