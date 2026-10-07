# team check

The old spelling of the two commands that took its halves: [`team commits check`](commits.md)
checks a commit or a range, and [`team pr check`](pr.md) checks a pull request's body alone. A
`team check` with any argument at all is still read through 0.3.3 — the call runs as it always
has, with one notice line naming the new command first.

A `team check` with **no argument at all** is reserved for the team's own check: a different
command, and not built in this build. There is nothing to accept yet, so bare `team check`
refuses exactly as it always has, and never runs the old commit check.

## Synopsis

    team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

## The old spelling, one notice line

Any argument is the old spelling. The run is the one the new names run — the commits half, and
with `--pr` the body half as well — and one line goes to standard error before the command's own
bytes, naming the new command:

    team check: `team check` is now `team commits check`, and is still read through 0.3.3
    team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3

A plain call prints the first line; a `--pr` call prints both, the commits one first. Every line
under the notices names the new command (`team commits check: …`, `team pr check: …`), and the
exit codes are the ones [`commits check`](commits.md) and [`pr check`](pr.md) have. A refused
invocation — a missing or doubled `<ref>`, an unknown option — keeps the bytes it always had and
takes no notice: an error already says what to fix.

## Bare `team check`

Not the old spelling, and not built yet either: the team's own check arrives in a later build.
Until then it refuses exactly as it did before the rename, and runs nothing:

```console
$ team check ; echo "exit $?"
team check: a <ref> is required

Usage: team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --pr <file>      also check a pull request's body ("-" reads standard input)
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    the team file, instead of .agents/team.yaml

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
exit 2
```

## Refusals

The invocation's own, in the old bytes:

| Message | Exit |
| --- | --- |
| `team check: a <ref> is required` (with the usage) | 2 |
| `team check: one <ref> at most` (with the usage) | 2 |
| `team check: unknown option --<name>` (with the usage) | 2 |
| `team check: --pr needs a value` (with the usage) | 2 |

Everything else leaves through the new commands and prints their names; their pages carry those
tables.

## Exit codes

- `0` — every commit checked passes, and so does the pull request body when one was given.
- `1` — at least one commit, or the body, was refused.
- `2` — the invocation can't be read; the run's own refusals are the new commands' 2s, on their pages.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

identity:
  humans: [jane@acme.example]

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

```commit
Tidy the logs

The reader printed one line too many, so the reports carried noise.

Claude-Session: 8f21c4a9
Agent: Claude Opus 5.5 · implementer
```

The old spelling runs the commits check, one notice line first:

```console
$ team check HEAD ; echo "exit $?"
team check: `team check` is now `team commits check`, and is still read through 0.3.3
team commits check: warning: line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
<sha> Tidy the logs
  line 5: forbidden pattern ^Claude-Session:
    Claude-Session: 8f21c4a9
team commits check: 1 commit checked: 1 commit refused
exit 1
```

With `--pr` both halves run, and both notices print — the commits one first:

```file file=pr.md
The metrics page is ready for review.

**Agent:** Claude Opus 5.5 · implementer
```

```console
$ team check HEAD --pr pr.md ; echo "exit $?"
team check: `team check` is now `team commits check`, and is still read through 0.3.3
team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3
team commits check: warning: line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
<sha> Tidy the logs
  line 5: forbidden pattern ^Claude-Session:
    Claude-Session: 8f21c4a9
team commits check: 1 commit checked, 1 pull request body checked: 1 commit refused
exit 1
```
