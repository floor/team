# team doctor

Reads the machine and says what the team needs before it can run: whether this file is the one the
owner approved, whether herdr and each seat's CLI are installed, at the tested version and logged in,
whether each launch names the model the file says — and, when it names none, what checks the model
the seat really runs — whether a watch has run for the session, and what each approved budget check
reads right now. `up` and `add` refuse until the missing ones are done.

## Synopsis

    team doctor [--session <name>] [--file <path>] [--login]

## What it reads and writes

Reads the team file (or the one `--file` names) and its warnings, this machine's approval store, the
session's state (`.agents/team.state.json`, for the watch's heartbeat), herdr's version and whether
the session is running, and, for each CLI a seat uses, `<binary> --version` and its login check. A
seat's own launcher is looked for on the `PATH`, never run to find out. The owner's `doctor` also
runs each approved account's check command once, the way the watch runs it; the command's raw output
is parsed and dropped, never shown. It writes nothing.

## Who may run it

Anyone, in any terminal. It needs no approval of its own — reporting on the approval is its work.
The budget checks run only for the owner, whose approvals they are; any other caller gets the same
report without the readings.

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session to report on, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--login` | read the seats' CLIs' logins alone, one line per CLI, instead of the whole report; herdr, the session and the machine are not read |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

One line per finding, the level first, then two spaces:

    ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)
    warn  claude-beacon: its name repeats "beacon"; the session already carries it
    warn  claude-beacon: the launch starts Claude Opus 5.5, the file says Claude Sonnet 5.5
    --    codex-scribe: the model is chosen by its launcher; checked on the running seat
    MISS  install `codex`: it is not on the PATH (codex: codex-scribe)
    --    session beacon is running

| Level | Meaning |
| --- | --- |
| `ok  ` | as it should be |
| `warn` | worth knowing; `up` and `add` go ahead |
| `MISS` | a reason to refuse: something has to be installed, logged in or approved first |
| `--  ` | neither: a note, like whether the session is running |

The findings come in order: the file's own warnings, one warning per seat whose name or label
repeats the project or the session (the session already carries it; the warning never refuses the
file), the approval — `ok  ` with the signing's number, its date and the signing key's
fingerprint (`ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)`) when the record
verifies, `MISS` with the one-line repair when it does not: never approved on this machine,
written before records were signed, or refused with the case — the override file when it is not the approved copy or cannot be parsed (a
missing line either way: `up` and `add` refuse, and the approved copy stays in force — or the
shipped profiles, when nothing was approved), each account whose `check`
command is unapproved, or no longer matches the file hashed at approval (a warning either way: that
account reads unknown, and `up` and `add` still
run), the budget checks, herdr, one CLI at a time (its
version, its login, then each of its seats' launchers and models), the watch, and the `trust` note.
A seat the file stops is left out of the CLI findings. A CLI outside its tested range keeps its
`warn` and says what that means: its screens are untested with this version, and a seat that isn't
read at launch is left out, never typed into (herdr's version line says just where it sits — herdr
has no screens). The last line counts them:

    team doctor: nothing missing, 1 warning
    team doctor: 2 missing, 0 warnings: `up` and `add` refuse until the missing ones are done

A seat's model is judged by what can check it. A launch that names a model the profile knows is
compared with the file's, and a mismatch is the warning above. A launch that names none is left to
the running seat whenever the CLI's screen shows the model it runs: a launcher — a script or
program that runs the CLI and picks the model itself, told by the launch line's first words, or by
the seat's `model_from: launcher` — gets the note `--    <seat>: the model is chosen by its
launcher; checked on the running seat`, and the CLI's own binary started bare prints nothing, since
`status` and the watch read the model off its screen. Two cases nothing can check stay warnings: a
CLI that keeps no model on its screen (`<seat>: no model flag and this CLI doesn't show its model;
nothing checks that it runs <declared>`), and a CLI this version knows to start on its last-used
model, which keeps its `warn` for another change to reword. The model the file declares is spelled
by the seat's `display` in every line that names it.

The key's fingerprint is the first twelve hex digits of the signing key's public half. What it
proves is narrow: an owner who noted it sees a *replaced* key — a process that only reads the
key changes nothing `team` shows. `team` computes it, and a seat could also replace `team`.

The budget checks run from the approved `budgets` copy, the way the watch runs them: the approved
command's file, hashed again before it runs, with the watch's timeout. A check that was changed
after its approval never runs — the warning above says so. One line per account that names a
check: the reading it gave (`ok  `), or that its output broke the contract, or that it failed or
timed out (both `warn`: that account reads unknown; neither changes the exit code). The command's
raw output is never shown, logged or written anywhere, and a reading is reported, not stored. A
caller who is not the owner runs no check: one line says so, and everything else is as the
owner's. An account nothing can read — its `sources` name the status line but no seat's CLI
ships a quota pattern for it — has a warning of its own: `no pattern can read this account`. An
account read only by a check is fine.

`--login` reads the logins alone: one line per CLI the file's seats use, in the order the seats first
name them, then the same last line. A login check that passed is `ok  `; one that failed is `MISS`,
with the command that logs in; a CLI that can't be asked — one with no login check, or no launch
profile in this version — is `--  `.

A watch that has not run, or whose heartbeat is old, is `MISS` here but not a reason for `up` to
refuse: `up` starts the watch itself.

## Refusals

| Message | Exit |
| --- | --- |
| `team doctor: unknown option --x` / `team doctor: unexpected "x"` / `team doctor: --session needs a value` (each with the usage) | 2 |
| `team doctor: line <n>: <message>` / `team doctor: <message>` | 2 |

## Exit codes

- `0` — nothing missing; warnings do not change this.
- `1` — at least one `MISS`.
- `2` — the invocation or the team file can't be read.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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

The account's check is a script of the owner's, hashed at approval; a fake one stands in here:

```file file=.agents/openai-quota exec=1
#!/bin/sh
echo "weekly 40% used"
```

```fixture
tools:
  codex: missing
```

Everything here is as it should be:

```console
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    the watch is running
team doctor: nothing missing, 1 warning
exit 0
```

A CLI outside the range this version was tested with keeps its warning and says what that means —
herdr's own version line says only where it sits, for the same reason:

```console tools="claude-code=old"
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
--    session beacon is running
warn  claude 2.1.200 is older than the tested 2.1.288: its screens are untested with this version; a seat that isn't read at launch is left out, never typed into
ok    claude-code: logged in
ok    the watch is running
team doctor: nothing missing, 2 warnings
exit 0
```

A seat's `doctor` runs no check — only the owner's approvals may run them — and one line says so;
everything else is as the owner's:

```console caller=claude-beacon
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)
--    the budget checks were not run: only the owner runs them
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    the watch is running
team doctor: nothing missing, 1 warning
exit 0
```

A seat on a CLI that is not installed needs the file approved again, since it is new, and the CLI
installed:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
```

```console
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
MISS  run `team approve`: `limits` changed; seat codex-scribe is not in the approved file
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
MISS  install `codex`: it is not on the PATH (codex: codex-scribe)
ok    the watch is running
team doctor: 2 missing, 1 warning: `up` and `add` refuse until the missing ones are done
exit 1
```

A launch that names another model than the file does is a warning, not a refusal — `up` starts what
the launch says:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
```

```console
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
MISS  run `team approve`: `limits` changed; seat claude-beacon changed; seat codex-scribe is not in the approved file
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
warn  claude-beacon: the launch starts Claude Opus 5.5, the file says Claude Sonnet 5.5
MISS  install `codex`: it is not on the PATH (codex: codex-scribe)
ok    the watch is running
team doctor: 2 missing, 2 warnings: `up` and `add` refuse until the missing ones are done
exit 1
```

A launch that names no model is not warned for its own sake: what the seat really runs is read off
its screen by `status` and the watch, and `doctor` says only what that reading cannot cover. A
launcher — here a wrapper script — gets the note; the CLI's own binary started bare prints nothing
at all, its model checked the same way:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: team-codex          # the wrapper picks the model and runs codex

  - role: implementer
    name: codex-reader
    label: implementer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
```

```console tools="codex=fine"
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
MISS  run `team approve`: `limits` changed; seat codex-scribe is not in the approved file; seat codex-reader is not in the approved file
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    codex 0.157.0
ok    codex: logged in
--    codex-scribe: the model is chosen by its launcher; checked on the running seat
ok    the watch is running
team doctor: 1 missing, 1 warning: `up` and `add` refuse until the missing ones are done
exit 1
```

The launcher is told by the launch line's first words: none of them is the CLI's own binary (or a
path ending in it), so the line runs something that chooses the model itself. A seat may say so
outright with `model_from: launcher`, which wins over the launch line's shape; the key is part of
the seat's approval, as any seat key is.

`--login` answers the one question that needs no herdr, no session and no machine — which CLIs have
an account to run under. Two seats share a CLI, so it is said once:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
```

```console tools="codex=logged-out"
$ team doctor --login ; echo "exit $?"
ok    claude-code: logged in
MISS  log in to codex: `codex login`
team doctor: 1 missing, 0 warnings: `up` and `add` refuse until the missing ones are done
exit 1
```

A check that was edited after its approval never runs: the file on disk no longer hashes to what
the owner approved, and the account reads unknown until `team approve` is run again. The file
itself is back to the approved one here; only the script changed:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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

```file file=.agents/openai-quota exec=1
#!/bin/sh
echo "weekly 99% used"
```

```console
$ team doctor ; echo "exit $?"
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)
warn  the check for openai changed after approval and was not run; that account reads unknown
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    the watch is running
team doctor: nothing missing, 2 warnings
exit 0
```

An option it doesn't know stops it before it reads anything:

```console
$ team doctor --nope ; echo "exit $?"
team doctor: unknown option --nope
Usage: team doctor [--session <name>] [--file <path>] [--login]
exit 2
```
