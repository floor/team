# team next

Claims one record from the file the team file names, and holds it with a lease in this clone.
A seat cannot pull until `team up` has recorded its pane.

The source is a file the owner committed. No command in this build contacts a tracker.
The broker is not built. Credential-withholding is not this slice. There is no tracker
credential here to withhold.
When a broker is built, a broker under the same OS principal as the seat is integrity, not
authenticity. This command does not isolate anything.
A lease is a file in this clone. Two live leases in this clone do not cover one id. Another
clone, and another machine, are outside that promise.
An expired lease returns the record to the queue. Another seat may take it, and the work may
be done twice.
The file is the intake for this slice. A record is takeable because the owner wrote it there.
That is not the owner-set intake rule. `team plan` is not a command.
`title` and `description` are the owner's text. They are not scrubbed.
A record with `blocked-by`, `repos`, or `needs` is listed by `team issues` and is not taken.
A deadline is printed and not read as a time. A missed deadline is not decided here.
Releasing a lease records no progress.
The watch's ring is unchanged: `Team: run team messages`.

## Synopsis

    team next [--mine | --release]

## What it reads and writes

Reads the git checkout (`findRoot`), the team file, the YAML list at `tasks.path`, and the
lease files under `.agents/leases/` in this clone. The path is relative to the checkout. A
record's `id` and `title` are required. The printed block is the `team issues` block, one
record. No lease field is printed.

Writes one lease file, `.agents/leases/<id>.json`, or rewrites the caller's own live file.
The lease lasts 30 minutes. A re-run while it is live renews it and prints that record again.
It does not take a second id. `--release` unlinks the caller's file and records no progress.
An expired lease returns the record to the queue. `team next` does not edit `.git/info/exclude`
and does not write the task file.

## Who may run it

A declared seat of this team, on the pane the state records for that seat. Any declared seat
may pull, not only the orchestrator. The owner is refused. A name that is not a seat is
refused the same way.

A team that has never been started has no recorded pane, so a seat cannot pull until `team up`
has recorded one:

```text
team next: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up`
```

The wrong pane is refused with the pane the state records:

```text
team next: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`)
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--mine` | a new take keeps only records whose `assignee` is the caller's seat name. It does not filter a renewal |
| `--release` | unlink the caller's lease and print `team next: released <id>`. Records no progress |
| `--help`, `-h` | the usage, and exit 0 |

`--mine` and `--release` together are refused, and no file is written.

## What it prints

One record, the issues block. Nothing else on stdout when a record was claimed.

`team next: nothing is takeable` when the takeable set is empty. That is one answer, not a
poll and not a stand-down.

`team next: nothing is assigned to you` when `--mine` has nothing to take.

`team next: nothing is held` when `--release` finds no file of the caller's.

`team next: released <id>` when the caller's file was unlinked.

## Refusals

```text
team next: only a seat of this team pulls a task; this call is owner
team next: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up`
team next: the team file declares no task source
team next: tasks.source must be file
team next: tasks.path must stay inside the checkout
team next: the task file is not there
team next: the task file is not a list
team next: m1 is not a task: title is required
team next: --mine and --release are not used together
```

A record that is not a task is named on stderr and is not a candidate. If another record is
claimed, the exit is still 0. If nothing is claimed and any record was refused, stdout has no
block and the exit is 1.

## Exit codes

- `0` — a record was claimed, the caller's live lease was renewed, a lease was released, or there was nothing to take or to release.
- `1` — the caller is not a seat of this team on its recorded pane, the team file can't be read, the task file is missing or not a list, or nothing was taken and a record is not a task.
- `2` — the invocation can't be read, or this folder is not a git checkout.

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

tasks:
  source: file
  path: .agents/tasks.yaml

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

```yaml file=.agents/tasks.yaml
- id: m1
  title: the task title
```

```console caller=claude-keeper
$ team next ; echo "exit $?"
m1  the task title
exit 0
```
