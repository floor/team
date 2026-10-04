# team check

Checks a commit, or a range of commits, against the team file's rules: every commit must carry a
seat's signature where the file says, no line of its message may match a forbidden pattern, and,
with `--pr`, a pull request's body is held to the same rules. `check` is what a seat runs on its own
branch before it reports, and what CI runs on every push.

## Synopsis

    team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), the ledger of this machine's store (every seat the
team has had here, so a removed seat's commits still pass), the git history of `<ref>`, and, with
`--pr`, the file holding the pull request's body. It writes nothing: no state file, no log line, no
store.

## Who may run it

Anyone. It needs no herdr session, no terminal and no approval of its own; a seat runs it on its own
branch and CI runs it on a push.

## Flags

| Flag | Meaning |
| --- | --- |
| `<ref>` | one commit, or a range when it holds `..`, passed to git as given (`origin/main..HEAD`) |
| `--pr <file>` | also check a pull request's body, read from `<file>`; `-` reads standard input |
| `--since <ref>` | skip this commit and everything reachable from it, for this run; overrides `identity.since` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--help`, `-h` | the usage, and exit 0 |

## What it finds

Every offending commit is printed with its hash and subject, then one block per finding:

    <sha> Tidy the logs
      line 5: forbidden pattern ^Claude-Session:
        Claude-Session: 8f21c4a9

| Finding | Meaning |
| --- | --- |
| `no signature: expected "Agent: {display} · {role}" in the final trailer block` | the message carries no signature at all |
| `the signature is not in the final trailer block` | a seat's signature is there, but not where the file's rule says |
| `the signature shares its paragraph with prose ("…"), so git reads no trailer block: put it in a paragraph of its own, with trailers only` | the signature touches ordinary text, so git reads no trailer |
| `a signature no seat of this team has had (the model, the version and the role must all match one seat)` | a signature-shaped line naming a model, version or role no seat has |
| `forbidden pattern <source>` | the line matches one of the file's patterns, or one of the two defaults |

The summary says what was read — `<n> commits checked`, `<n> by a human or a merge`, `<n> skipped
(since <ref>)`, `1 pull request body checked` — and then `ok`, or `1 commit refused`, or `2 commits
refused`, or `the pull request body refused`.

## Refusals

| Message | Exit |
| --- | --- |
| `team check: a <ref> is required` (with the usage) | 2 |
| `team check: one <ref> at most` (with the usage) | 2 |
| `team check: unknown option --<name>` (with the usage) | 2 |
| `team check: --pr needs a value` (with the usage) | 2 |
| `team check: <path>, line <n>: <message>` | 2 |
| `team check: can't read the pull request body: <error>` | 2 |
| `team check: not in a git repository` | 2 |
| `team check: "<ref>" doesn't name a commit` | 2 |
| `team check: the range "<ref>" can't be resolved` | 2 |
| `team check: the range "<ref>" holds no commit` | 2 |
| `team check: since "<ref>" doesn't name a commit here (a shallow clone doesn't hold the history it needs)` | 2 |
| `team check: since "<ref>" is not reachable from "<ref>"` | 2 |

## Exit codes

- `0` — every commit checked passes, and so does the pull request body when one was given.
- `1` — at least one commit, or the body, was refused.
- `2` — the check can't run: a bad invocation, a team file that can't be read, a ref that names nothing.

## Examples

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

identity:
  humans: [jane@acme.example]

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

A seat signs its commits in a trailer block of its own:

```commit
Sketch the layout

Agent: Claude Opus 5.5 · implementer
```

The person named in `identity.humans` never signs:

```commit email=jane@acme.example
Review the copy
```

This one forgot, and this one signed but leaked a line the file forbids:

```commit
Add the metrics page

The counters come from the tracker's webhook, not from a poll.
```

```commit
Tidy the logs

The reader printed one line too many, so the reports carried noise.

Claude-Session: 8f21c4a9
Agent: Claude Opus 5.5 · implementer
```

```file file=pr.md
The metrics page is ready for review.

**Agent:** Claude Opus 5.5 · implementer
```

The commit a person wrote needs no signature:

```console
$ team check HEAD~2 ; echo "exit $?"
team check: 1 commit checked, 1 by a human or a merge: ok
exit 0
```

The newest commit signs, but leaks the forbidden line:

```console
$ team check HEAD ; echo "exit $?"
<sha> Tidy the logs
  line 5: forbidden pattern ^Claude-Session:
    Claude-Session: 8f21c4a9
team check: 1 commit checked: 1 commit refused
exit 1
```

A range reads newest first and reports every commit with findings:

```console
$ team check HEAD~3..HEAD ; echo "exit $?"
<sha> Tidy the logs
  line 5: forbidden pattern ^Claude-Session:
    Claude-Session: 8f21c4a9
<sha> Add the metrics page
  no signature: expected "Agent: {display} · {role}" in the final trailer block
team check: 3 commits checked, 1 by a human or a merge: 2 commits refused
exit 1
```

`--since` leaves that commit and everything reachable from it out of the report:

```console
$ team check HEAD~3..HEAD --since HEAD~1 ; echo "exit $?"
<sha> Tidy the logs
  line 5: forbidden pattern ^Claude-Session:
    Claude-Session: 8f21c4a9
team check: 1 commit checked, 2 skipped (since <sha>): 1 commit refused
exit 1
```

A pull request's body is checked as well:

```console
$ team check HEAD~3..HEAD --pr pr.md ; echo "exit $?"
<sha> Tidy the logs
  line 5: forbidden pattern ^Claude-Session:
    Claude-Session: 8f21c4a9
<sha> Add the metrics page
  no signature: expected "Agent: {display} · {role}" in the final trailer block
team check: 3 commits checked, 1 by a human or a merge, 1 pull request body checked: 2 commits refused
exit 1
```

A ref that names nothing can't be checked:

```console
$ team check origin/main ; echo "exit $?"
team check: "origin/main" doesn't name a commit
exit 2
```
