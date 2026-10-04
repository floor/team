# team worktree

Creates and removes a task worktree: a second checkout of the project on a branch of its own, where
one seat does one task. `new` cuts the branch from `workspace.base`, records the worktree in the
session's state and prints its folder; `remove` deletes a worktree that holds nothing that would be
lost, and keeps its branch.

## Synopsis

    team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]
    team worktree remove <task> [--session <name>] [--file <path>]

    Ignored files in the worktree are deleted with it.

## What it reads and writes

Reads the team file and this machine's approval store (the file must be the approved one), the
session's state (`.agents/team.state.json`), and git: the base branch, the branch names, and the
worktree itself. With `--session`, the state of that session instead of `team.session`.

Writes `.agents/team.log`, `.agents/team.state.json` (one record under the session: the folder, the
branch, the seat when `--seat` names one, and whether `workspace.setup` succeeded), and, with `new`,
the worktree itself and the branch it cuts.

The folder is `workspace.path` with `{repo}` and `{task}` filled; the branch is `workspace.branch`
with `{kind}` and `{task}` filled. `new` fetches the base's upstream when it has one, and starts from
the local base, with a note in the log, when it doesn't. Nothing is created when the fetch fails.

## Who may run it

The owner, the coordinator's seat, and the operator's seat. `--file` is the owner's alone, from a
terminal outside herdr.

## Flags

| Flag | Meaning |
| --- | --- |
| `<task>` | one path segment: letters, digits, `.`, `_`, `-`, starting with a letter or a digit |
| `--kind <kind>` | fills `{kind}` in `workspace.branch`; required when the pattern holds it, refused when it doesn't |
| `--seat <name>` | records a declared seat in the worktree's record |
| `--session <name>` | the session whose state is read and written, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |

`remove` takes no `--kind` and no `--seat`.

## Refusals

| Message | Exit |
| --- | --- |
| `team worktree: a subcommand is required` / `unknown subcommand "x"` / `a task name is required` / `unexpected "x"` (each with the usage) | 2 |
| `team worktree: remove takes no --kind or --seat` (with the usage) | 2 |
| `team worktree: line <n>: <message>` | 2 |
| `team worktree: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team worktree: only the owner, the coordinator or the operator runs it; this call is <caller>` | 1 |
| `team worktree: session can't be "default", herdr's own session` | 1 |
| ``team worktree: the file was never approved on this machine: run `team approve` `` | 1 |
| ``team worktree: the file is not the approved one (<differences>): run `team approve` `` | 1 |
| `team worktree: a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit` | 1 |
| `team worktree: --kind: <the same, for the kind>` | 1 |
| `team worktree: workspace.mode is shared: this team keeps one checkout, so there is no task worktree to create` | 1 |
| `team worktree: workspace.path and workspace.base are required` | 1 |
| `team worktree: --kind is required: the branch pattern is "{kind}/{task}"` | 1 |
| `team worktree: --kind has nowhere to go: the branch pattern is "{task}"` | 1 |
| `team worktree: <folder> is outside the approved trust paths` | 1 |
| `team worktree: --seat "x" names no declared seat` | 1 |
| `team worktree: "t" is already recorded` / `"t" is already recorded in session x` | 1 |
| `team worktree: the worktree limit is 8, and 8 are open` | 1 |
| `team worktree: <folder> already exists` / `branch <b> already exists` / `<remote>/<b> already exists` | 1 |
| `team worktree: "b" is not a branch name` | 1 |
| `team worktree: workspace.base "main" is not a branch here; nothing was created` | 1 |
| `team worktree: couldn't fetch <remote>: <first line>. Nothing was created.` | 1 |
| `team worktree: the worktree was not created: <first line of git's error>` | 1 |
| `team worktree: setup failed on command <n> of <m>; the worktree is kept and recorded as setup: failed` | 1 |
| `team worktree: no worktree named "t" is recorded` | 1 |
| `team worktree: "t" is recorded in session x, not in y; nothing was removed` | 1 |
| `team worktree: seat <name> is recorded in this worktree; team remove <name> first` | 1 |
| `team worktree: uncommitted or untracked files:` … the first twenty, one per line | 1 |
| `team worktree: commits on no remote branch:` … the first twenty, one per line | 1 |
| `team worktree: the worktree was not removed: <first line of git's error>` | 1 |

When `setup` fails, the folder is still printed on stdout before the refusal: the worktree is kept,
recorded as `setup: failed`, and the exit code is 1.

## Exit codes

- `0` — the worktree was created, or removed; its folder, or what was removed, is printed on stdout.
- `1` — refused: a rule above, whatever the caller, the file, the name or git says.
- `2` — the invocation or the team file can't be read.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - .
  - ../worktrees/beacon/*

workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main

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

The project has a `main` for the branches to start from:

```commit
Sketch the layout
```

A seat that isn't the coordinator or the operator can't create one:

```console caller=claude-beacon
$ team worktree new select-width --kind fix ; echo "exit $?"
team worktree: only the owner, the coordinator or the operator runs it; this call is claude-beacon
exit 1
```

The branch pattern asks for a kind, so the command does:

```console
$ team worktree new select-width ; echo "exit $?"
team worktree: --kind is required: the branch pattern is "{kind}/{task}"
exit 1
```

The task name is one path segment, and nothing else:

```console
$ team worktree new "select width" --kind fix ; echo "exit $?"
team worktree: a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit
exit 1
```

A good one creates the worktree and prints where it is:

```console
$ team worktree new select-width --kind fix
../worktrees/beacon/select-width
```

The same task can't be open twice:

```console
$ team worktree new select-width --kind fix ; echo "exit $?"
team worktree: "select-width" is already recorded
exit 1
```

A commit that lives only in the worktree keeps it in place:

```git
-C ../worktrees/beacon/select-width commit --allow-empty -m "Measure the pane"
```

```console
$ team worktree remove select-width ; echo "exit $?"
team worktree: commits on no remote branch:
  <sha> Measure the pane
exit 1
```

A worktree with nothing to lose goes, and its branch stays:

```console
$ team worktree new tidy-logs --kind chore
../worktrees/beacon/tidy-logs
```

```console
$ team worktree remove tidy-logs
removed tidy-logs; the branch chore/tidy-logs is kept
```
