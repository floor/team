# team usage

Shows one project's figures: the accounts and windows its budgets in force name, with what is left
and used, when each figure was last read and from which source. It resolves the project from the
current folder, the way every command does, and it only reads: it writes nothing anywhere — no
`last_valid` copy, no log line, no lock, no state — it runs nothing, it reads no pane, and it opens
no CLI's own session file or credential. Any caller may run it, from any folder.

## Synopsis

    team usage [--json]

## What it reads and writes

Reads the team file at the project's root (`.agents/team.yaml`), the state beside it
(`.agents/team.state.json`) and this machine's approval store — the copy the owner approved, and
the signing key that verifies it. It writes **nothing at all**: unlike `status`, it keeps no
`last_valid` copy of the file it read, and unlike `up`, `add` and `watch` it opens no lock, writes
no state and logs no line. A file that does not load, or one that has drifted from the approved
copy, is answered from the copy the approval stored; when neither can be read, the block says
`no figures (the file could not be read)`.

## Who may run it

Anyone: a seat, an unplaced agent, or the owner. It needs no approval of its own — it reports on
the one in force, and changes nothing about it. It may be run from anywhere inside the project,
a subfolder or a linked worktree alike: the root is the one git's common directory names, or, in a
plain folder with no repository, the folder's own `.agents/team.yaml`. Outside any project it
prints one note line and exits 0 — a note, not a refusal:

    note: no team file is found from this folder; there is no project block to show

## Flags

| Flag | Meaning |
| --- | --- |
| `--json` | print the same reading as one JSON document instead of the block |
| `--help`, `-h` | the usage, and exit 0 |

## The block

    team beacon
      openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh

The header is the project. Under it, one row per account and window, indented two spaces: the same
rows, in the same shape, that `team status` prints under `budgets:`, because they are built by the
same table from the same state. Each row carries the account and window, what is left and used,
when it resets, the seat the figure came from, how long since it changed, the source it was counted
from, and its state — `fresh`, `stale`, `unconfirmed` or `unknown`. A figure inside its reserve
says so, `status line (fallback)` marks a row whose figure did not come from the first source the
account names, and an account the file names with no reading is `unknown`. A row that carries no
figure is never dressed up as one.

Two lines can follow the rows. A watch that is recording is not announced; a project with no watch
record prints `no watch is recording for <project>`, and a state whose watch record cannot be read
leaves it `not known whether a watch is recording`. Anything else the state could not be read for
is a `note:` line with the file and the reason, as in `status`. The exit code is 0 either way.

## The JSON

`--json` prints the same reading as one document, format 1, for a script to read:

    {
      "format": 1,
      "at": "2026-10-04T09:00:00.000Z",
      "view": "restricted",
      "mine": "beacon",
      "rows": [{ "account": "openai", "window": "session", "left": 40, "used": 60, "resetsIn": "44m", "seat": null, "age": "2m", "source": "check", "fallback": false, "state": "fresh", "inside": false, "reserve": 20 }],
      "watch": "recording",
      "notes": []
    }

`rows` holds exactly what the block's rows hold, as `status --json` prints them under `budgets`.
`watch` is `recording`, `not-recording` or `not-known` — the three faces the block prints as
nothing, one line, or the other line. `notes` holds the state's own reasons, as the block's
`note:` lines. `at` is the moment the reading was taken, and `mine` the project, or null outside
any project — in which case `rows` is empty, `watch` is `not-known` and `notes` holds the one
sentence the block prints.

## Refusals

| Message | Exit |
| --- | --- |
| `team usage: <the parser's own error>`, with the usage | 2 |

Everything else — no project here, a file that does not load, a state that cannot be read — is a
note line and exit 0. The command runs no check, opens no pane and calls no CLI, so nothing else
can refuse it.

## Exit codes

- `0` — the block printed, or there was no project block to show and the notes say why.
- `2` — the invocation can't be read.

## Examples

The file below names one account with both a check and the shipped status line as its sources, so
its `session` window is read from the check and the windows the check does not report — `daily`,
`weekly` — come from the status line, marked `(fallback)`:

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
    openai/daily/claude-keeper:
      account: openai
      window: daily
      left: 70
      used: 30
      changedAt: "2026-10-04T08:20:00Z"
      resetsAt: null
      seat: claude-keeper
      source: status_line
      confirmed: true
    openai/weekly/claude-keeper:
      account: openai
      window: weekly
      left: 5
      used: 95
      changedAt: "2026-10-04T08:58:00Z"
      resetsAt: "2026-10-04T09:44:00Z"
      seat: claude-keeper
      source: status_line
      confirmed: true
```

The state holds the watch's own last readings: a fresh check figure for the `session` window, a
`daily` one from the status line last seen 40 minutes ago, and a `weekly` one inside its reserve.
The watch is alive, so no watch line follows the rows:

```console
$ team usage ; echo "exit $?"
team beacon
  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh
  openai  daily  left 70%  used 30%  resets unknown  claude-keeper  last seen 40m ago  status line (fallback)  stale
  openai  weekly  left 5%  used 95%  resets in 44m  claude-keeper  changed 2m ago  status line (fallback)  fresh, inside reserve 20%
exit 0
```

`--json` prints the same reading as one document. `at` is the moment of the read, so a script can
see the age of every figure against it:

```console
$ team usage --json ; echo "exit $?"
{
  "format": 1,
  "at": "2026-10-04T09:00:00.000Z",
  "view": "restricted",
  "mine": "beacon",
  "rows": [
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
      "seat": "claude-keeper",
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
      "seat": "claude-keeper",
      "age": "2m",
      "source": "status_line",
      "fallback": true,
      "state": "fresh",
      "inside": true,
      "reserve": 20
    }
  ],
  "watch": "recording",
  "notes": []
}
exit 0
```

The same command from a seat's pane, or from a folder with no project above it, reads the same
project or prints the one note line; nothing about the reading changes with who runs it.
