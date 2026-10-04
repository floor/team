# team status

Shows the team as it stands: one line per seat with what the session's herdr shows of it, and one
`difference` for each way the file, the state and the live session disagree. Read-only: `status`
changes nothing, and names the command that repairs each difference.

## Synopsis

    team status [--session <name>] [--file <path>] [--json]

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store, the session's state
(`.agents/team.state.json`), and herdr: the agents, their panes, their workspaces, and each pane's
visible text, from which the running model is read. It writes nothing.

## Who may run it

Anyone, in any terminal, and it needs no approval of its own. It does need herdr to answer: without
it, `status` can't say anything and exits 2.

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session to read, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--json` | print the same reading as one JSON document instead of the table, the notes and the repairs |
| `--help`, `-h` | the usage, and exit 0 |

## Rows

    team beacon, session "beacon"
      claude-keeper  missing  Claude Opus 5.5  -
      claude-beacon  working  Claude Opus 5.5  w1:p1

The columns are the seat, its state, the model, and the pane. The state is what herdr says
(`idle`, `working`, `blocked`…), with `, parked` added for a seat the file parks and `, temporary`
for a temporary one; or `missing` when the seat is in the file and nothing is running for it; or
`stopped` when the file marks it stopped; or `wrong name` when an agent sits in the seat's workspace
under another name.

The model is the seat's `display` when the running model matches the file, and
`<model> <version> (file: <display>)` when it doesn't. A screen that doesn't show the model is a
`note` rather than a difference: `unread` is never wrong.

An approval in force is a note of its own, `approval #1 (2026-10-04), key fe21ef6293de`: the
signing's number, its date and the key's fingerprint — the first twelve hex digits of the key's
public half. An owner who noted the fingerprint sees a *replaced* key; a process that only reads
it changes nothing `team` shows, and `team` computes what it shows.

## Budgets

When the file names an account, or a reading is stored in the state, a `budgets:` table follows
the seats. One row per account and window: what is left and used, when it resets, which seat the
figure came from, how long since it changed, the source it was counted from, and whether it is
fresh, unconfirmed, stale, refusing, or unknown. A row's account is the seat's own: its `account:`
when the file names one, its `vendor` when it doesn't, so one vendor's two accounts are two rows.
A figure inside its reserve says so on that row, including when it is still fresh.
When the counted figure did not come from the first source the account names, the row names the
source it did come from and marks it: `status line (fallback)`.
An old figure with no known reset reads unknown while it could still matter — inside its reserve,
or within the reserve again outside it. Further out — more than the reserve again — it is still
shown, its when column saying `last seen 40m ago`: the room the figure last held.
A named account with no reading is unknown. The table is left out when there is nothing
to show. `status` still writes nothing; the watch is what records a reading.

An openai account can take its figure from a check instead of the status line. Copy
`examples/checks/codex-quota` onto `PATH` and name it as that account's `check`, with
`check` listed before `status_line` in `sources`. The script prints the primary
window from the newest local rollout that has a quota figure, opening ten files
at most, and a second line when that event's secondary window is a different
length. For example `weekly 39% used resets 114h4m at 1791091200`. `team`
passes only `PATH` and `HOME`, so `CODEX_HOME` never reaches the script. With a
custom Codex home, install a two-line wrapper that sets it and execs this script,
and name the wrapper as the check:

```sh
#!/bin/sh
CODEX_HOME=/path/to/codex exec /path/to/codex-quota
```

## Differences

| Difference | Repair |
| --- | --- |
| `<seat> is in the file and is not running` | `team add <seat>` when something else runs, `team up` when nothing does |
| `<seat>: the agent in <pane> is named "x"` | `herdr --session <s> agent rename <pane> <seat>` |
| `<seat> runs <model> <version>; the file says <model> <version>` | restart it (`team remove <seat> --keep`, then `team add <seat>`), or correct the file and `team approve` |
| `<seat> is marked stopped in the file and is running` | `team remove <seat> --keep`, or take `stopped: true` off the seat |
| `<seat>: its launch stopped at "<stage>"` | `team up` (it resumes the launch) |
| `<seat>: its rules were not delivered` | `team remove <seat> --keep`, then `team add <seat>` |
| `<name>: a temporary seat is recorded and is not running` | `team remove <name>` |
| `no watch has run for this session` | `team watch --session <s>` |
| `the watch's last pass was <n> minute(s) ago` | `team watch --session <s>` |
| `an unnamed <cli> (w1:p2) is running and is not in the file` | add the seat to the file and `team approve`, or close it |
| `worktree <task>: its setup failed` | `team worktree remove <task>` |
| `the protected checkout "." is on "x", not on "main"` | `git -C . switch main` |
| `the file was never approved on this machine` | the owner runs `team approve` |
| `approved before records were signed: run `team approve` once`, or the case a refused record names | the owner runs `team approve` |
| `the file differs from the approved one: <line>` | the owner runs `team approve` |

## The JSON

`--json` prints the same reading as one document, format 1:

    {
      "format": 1,
      "project": "beacon",
      "session": "beacon",
      "rows": [{ "name": "claude-keeper", "state": "missing", "model": "Claude Opus 5.5", "pane": "-" }],
      "notes": [],
      "differences": [{ "what": "claude-keeper is in the file and is not running", "repair": "team add claude-keeper" }],
      "notice": null
    }

`rows`, `notes` and `differences` hold what the table, the notes and the repairs hold; `notice` is
the line a normal run prints above the table, or null when there is none. `budgets` is present only
when the budgets table would be printed, one object per row (`account`, `window`, `left`, `used`,
`resetsIn`, `seat`, `age`, `source`, `fallback`, `state`, `inside`, `reserve`). `inside` is true
when a subscription's left figure is at or inside its reserve, `fallback` when the figure did not
come from the first source the account names, and `reserve` the reserve that row was read against —
the same figure the table's line names, null when the account has none. The exit
code is the same as without `--json`, and the file's warnings still go to stderr.

## Refusals

| Message | Exit |
| --- | --- |
| `team status: unexpected "x"` (with the usage) | 2 |
| `team status: team.yaml line <n>: <message>` | 2 |
| `team status: herdr doesn't answer; is it installed and running?` | 2 |

A team file that loads with warnings prints them on stderr as
`team status: warning, line <n>: <message>` and goes on.

## Exit codes

- `0` — no difference: the file, the state and the live session agree.
- `1` — at least one difference; each is printed with its repair.
- `2` — the invocation or the team file can't be read, or herdr doesn't answer.

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

budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [check, status_line]
      check: examples/checks/codex-quota
```

```fixture
checks: [examples/checks/codex-quota]
agents: [claude-beacon]
screens:
  claude-beacon: working
state:
  budgets:
    openai/session:
      account: openai
      window: session
      left: 40
      used: 60
      changedAt: "2026-10-04T08:58:00Z"
      resetsAt: "2026-10-04T09:44:00Z"
      seat: null
      source: check
      confirmed: true
    openai/daily/claude-beacon:
      account: openai
      window: daily
      left: 70
      used: 30
      changedAt: "2026-10-04T08:20:00Z"
      resetsAt: null
      seat: claude-beacon
      source: status_line
      confirmed: true
    openai/weekly/claude-beacon:
      account: openai
      window: weekly
      left: 5
      used: 95
      changedAt: "2026-10-04T08:58:00Z"
      resetsAt: "2026-10-04T09:44:00Z"
      seat: claude-beacon
      source: status_line
      confirmed: true
```

Only the implementer is up, so the coordinator's seat is a difference with its repair. The state
also holds the watch's last readings for the `openai` account the file names: a check's `session`
window, a `daily` one from the status line last seen 40 minutes ago, and a `weekly` one the check
never reported — that one too comes from the status line, so its row marks it a fallback:

```console
$ team status ; echo "exit $?"
team beacon, session "beacon"
  claude-keeper  missing  Claude Opus 5.5  -
  claude-beacon  working  Claude Opus 5.5  w1:p1
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: approval #1 (2026-10-04), key fe21ef6293de
difference: claude-keeper is in the file and is not running
  repair: team add claude-keeper
1 difference(s)
exit 1
```

`--json` prints that reading as one document, for a script to read instead of the table:

```console
$ team status --json ; echo "exit $?"
{
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "rows": [
    {
      "name": "claude-keeper",
      "state": "missing",
      "model": "Claude Opus 5.5",
      "pane": "-"
    },
    {
      "name": "claude-beacon",
      "state": "working",
      "model": "Claude Opus 5.5",
      "pane": "w1:p1"
    }
  ],
  "notes": [
    "approval #1 (2026-10-04), key fe21ef6293de"
  ],
  "differences": [
    {
      "what": "claude-keeper is in the file and is not running",
      "repair": "team add claude-keeper"
    }
  ],
  "notice": null,
  "budgets": [
    {
      "account": "openai",
      "window": "session",
      "left": 40,
      "used": 60,
      "resetsIn": "44m",
      "seat": null,
      "age": "2m",
      "source": "check",
      "fallback": false,
      "state": "fresh",
      "inside": false,
      "reserve": 20
    },
    {
      "account": "openai",
      "window": "daily",
      "left": 70,
      "used": 30,
      "resetsIn": null,
      "seat": "claude-beacon",
      "age": "40m",
      "source": "status_line",
      "fallback": true,
      "state": "stale",
      "inside": false,
      "reserve": 20
    },
    {
      "account": "openai",
      "window": "weekly",
      "left": 5,
      "used": 95,
      "resetsIn": "44m",
      "seat": "claude-beacon",
      "age": "2m",
      "source": "status_line",
      "fallback": true,
      "state": "fresh",
      "inside": true,
      "reserve": 20
    }
  ]
}
exit 1
```

The repair is the command `add` starts a stopped or missing seat with:

```console
$ team add claude-keeper
claude-keeper: ready
```

Now nothing disagrees:

```console
$ team status ; echo "exit $?"
team beacon, session "beacon"
  claude-keeper  idle     Claude Opus 5.5  w2:p1
  claude-beacon  working  Claude Opus 5.5  w1:p1
budgets:
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-beacon  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-beacon  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
note: approval #1 (2026-10-04), key fe21ef6293de
0 difference(s)
exit 0
```
