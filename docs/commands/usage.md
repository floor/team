# team usage

Shows one project's figures: the accounts and windows its budgets in force name, with what is left
and used, when each figure was last read and from which source. It resolves the project from the
current folder, the way every command does, and it only reads: it writes nothing anywhere — no
`last_valid` copy, no log line, no lock, no state — it runs no check and launches no CLI, and it
reads no pane; it never opens a CLI's session file or a lab's credential; it reads TeamCLI's own
key only to verify the agreement, as `status` does. Any caller may run it, from any folder.

This page documents what this build prints: **one project's block** — no machine-wide view, and no
spend rows. The rows it does print are the ones `status` prints, from the same table over the same
state.

## Synopsis

    team usage [--json]

## What it reads and writes

Reads the team file at the project's root (`.agents/team.yaml`), the state beside it
(`.agents/team.state.json`) and this machine's approval store — the copy the owner approved, and
the signing key that verifies it. It writes **nothing at all**: unlike `status`, it keeps no
`last_valid` copy of the file it read, and unlike `up`, `add` and `watch` it opens no lock, writes
no state and logs no line. A file that has drifted from the approved copy is answered from the
copy the approval stored: the budgets in force are the approved copy's, and the why-line under the
rows says the file differs. A file that does not load, or cannot be read, prints no block at all —
the stored copy does not stand in for it, and a `note:` line carries the reason instead, in the
two faces the last paragraph rules. A file that is absent is the one note line of the section
above. When the block has neither a live file that validates nor a copy to fall back on, it says
`no figures (the file could not be read)`.

## Who may run it

Anyone: a seat, an unplaced agent, or the owner. It needs no approval of its own — it reports on
the one in force, and changes nothing about it. Who is asking is placed before anything prints,
the way `status` places it (`status.ts:133`): from the caller's parent processes — on macOS one
`ps` per parent, on Linux the `/proc` table — never from the environment. The owner at a terminal
reads the owner's view; every other caller, a run without a terminal included, reads the restricted
one. It may be run from anywhere inside the project, a subfolder or a linked worktree alike: the
root is the one git's common directory names, or, in a plain folder with no repository, the
folder's own `.agents/team.yaml`. Outside any project it prints one note line and exits 0 — a
note, not a refusal:

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

When nothing the file declares is counted, one line follows the rows before the watch's — the
next section has both faces. A watch that is recording is not announced; a project with no watch
record prints `no watch is recording for <project>`, and a state whose watch record cannot be read
leaves it `not known whether a watch is recording`. Anything else the state could not be read for
is a `note:` line with the file and the reason, as in `status`; a file that does not load is a
`note:` line too, and who reads which form of it is the last paragraph's rule. The exit code is 0 either way.

### When nothing the file declares is counted

A file that names no account gives the block nothing to count, and it says so in one line under
the rows — `--json` puts the same sentence first in `notes`. When there is nothing at all to
print, the block is the header, this line, and the watch's:

    team beacon
    not known: this team's file declares no account, so nothing is counted

The line prints even when rows do. A row is there for every reading the state still holds, and a
reading the budgets in force do not name is not an account any budget counts — so the sentence is
where a reader learns why figures can show with no budget behind them:

    team beacon
      openai  session  unknown
      openai  daily  unknown
      openai  weekly  left 5%  used 95%  resets in 44m  claude-keeper  changed 2m ago  status line  fresh
    not known: this team's file declares no account, so nothing is counted

A file that declares accounts but is not the approved one counts none of them either: the budgets
in force are the approved copy's — or, before any approval, the defaults', which name no account.
The line is the tool's own why-line for that standing, in the words `team status` already prints
for it — never approved:

    team beacon
    the file was never approved on this machine: run `team approve`

and, when a verified approval is in force but the file's `budgets` section differs from the
approved copy's:

    team beacon
    the file differs from the approved one: `budgets` changed

That line keys on the standing alone, not on the rows, so it too prints under the readings' own
rows. These are why-lines, not refusals: nothing is broken, and the exit code is still 0.

A refused approval — the store holds a record for this project that does not verify for it — has
two faces. The owner reads the store's own reason, the words `team status` prints for it, absolute
paths and all. Every other caller reads one fixed sentence instead, so that no reason text reaching
a non-owner can carry a path or a root that is not this project's own:

    team beacon
    the approval on this machine does not verify for this project: the owner runs `team approve`

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
`note:` lines — with the block's one line for a file that counts nothing first, so a script reads
it where the text's reader sees it. `at` is the moment the reading was taken, and `mine` the
project, or null outside any project — in which case `rows` is empty, `watch` is `not-known` and
`notes` holds what the block's `note:` lines say.

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
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: orchestrator
    name: claude-keeper
    label: orchestrator
    leads: true
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
project or prints the one note line: no figure, row, watch line or why-line changes with who runs
it. What a note says changes. The owner reads the notes `status` would print — the loader's own
message with the file's absolute path, the state's own reason. A caller who is not the owner reads
a file that does not load as one fixed sentence per line — `.agents/team.yaml does not load
(line 4): run team status for the reason`, where `team status` prints the loader's own message —
a file that cannot be read as `.agents/team.yaml cannot be read: the owner reads the reason` (no
pointer to `status` there: it throws on that file instead of printing anything), and the state's
own reason with this project's own path relative to the project root — `.agents/team.state.json is
not valid JSON; move it aside and run the command again`. No absolute path at all reaches a caller
who is not the owner, in the block or in `--json`.
