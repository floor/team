# team plan

Prints the queue a claim would consider, in the order `team next` would consider it. A seat
cannot pull until `team up` has recorded its pane, and this command is read only.

A plan is a listing: it claims nothing and writes no lease. It shows the records a claim would
consider, in the order `team next` would consider them — a record another seat holds can still
appear.

The queue is this clone's view of one source read.

A deadline the clock has passed is marked overdue here. The mark decides nothing: an overdue
record is still takeable and is never dropped, blocked, reordered or released by lateness. An
unparseable deadline is printed as written and unmarked.

The source is a file the owner committed, or a tracker the owner's broker reads. On a broker
source, `team plan` asks the broker the same read `team next` asks, and claims nothing. The
broker holds the tracker credential; this command never reads it.

The mark is against this clone's clock. Another machine's clock may disagree.

## Synopsis

    team plan

## What it reads and writes

Reads the git checkout (`findRoot`), the team file, and the YAML list at `tasks.path`. The path
is relative to the checkout. A record's `id` and `title` are required. The printed block is the
`team issues` block: the takeable records, one block each, in `team next`'s order — priority
first (a number before a text, ascending), then the `tasks.fallback` tie-break. A record with
`blocked-by`, `repos`, or `needs` is not takeable and is not printed.

On a broker source it reads the same git checkout and team file, then asks the broker over
`.agents/broker.sock`: one request line carrying the caller's seat and pane, one answer line
back, with a five-second deadline. The seat gate runs first; the broker checks the same claim
again on the request.

Writes nothing. No lease file, no renewal, no state write, and no tracker write. No file on
your disk records that you looked.

## Who may run it

A declared seat of this team, on the pane the state records for that seat. Any declared seat
may plan, not only the orchestrator. The owner is refused. A name that is not a seat is
refused the same way. The refusals are `team next`'s, with this command's prefix:

```text
team plan: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up`
team plan: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`)
```

## What it prints

The takeable records, one issues block per record. A deadline the clock has passed gains
` (overdue)` after its text.

`team plan: nothing is takeable` when no record is takeable. That is one answer, exit 0.

`team plan: the tracker holds more tasks than this read; the take still proceeds` on stderr when
the broker's answer says the tracker holds another page — the same notice `team next` prints.
The read is bounded, and it says so.

## Refusals

```text
team plan: only a seat of this team pulls a task; this call is owner
team plan: the team file declares no task source
team plan: tasks.source must be file
team plan: tasks.path must stay inside the checkout
team plan: the task file is not there
team plan: the task file is not a list
team plan: m1 is not a task: title is required
team plan: the broker is not running; the owner starts it with `team broker`
team plan: the broker's answer is not one this build knows; the owner restarts it
team plan: the broker accepted the request and did not answer; nothing is claimed
team plan: the broker failed this read
team plan: tasks.policy.omit must not name id or title, the record itself
```

`tasks.source must be file` is the local-adapter miss: it stands for a file source whose adapter
this build does not carry. A broker source never prints it — it goes to the broker path.

A record that is not a task is named on stderr and is not a candidate. If another record is
printed, the exit is still 0. If nothing is printed and any record was refused, stdout has no
block and the exit is 1.

## Exit codes

- `0` — the queue was printed, or there was nothing to take.
- `1` — the caller is not a seat of this team on its recorded pane, the team file can't be read, the task file is missing or not a list, nothing was printed and a record is not a task, or the broker path refused: no broker answered, the broker's answer was not one this build knows, the deadline passed, the broker refused the caller, or the broker failed the read.
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
  deadline: 2026-01-01T00:00:00Z
```

```console caller=claude-keeper
$ team plan ; echo "exit $?"
m1  the task title
  deadline: 2026-01-01T00:00:00Z (overdue)
exit 0
```
