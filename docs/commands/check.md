# team check

One answer to one question: **is anything wrong with this team that someone should act on?**
It reads the team file, the approval, the state and herdr, and changes nothing — no git is
needed, so it answers as well in a plain folder as in a repository. It is not
[`team status`](status.md) with fewer lines: status answers *what the team is* — the rows, the
budgets, every difference and note — and the check answers *what to act on*: the differences
alone, each with its repair.

`team check` is also the old name of the two commands that took its halves —
[`team commits check`](commits.md) and [`team pr check`](pr.md). A line that spells one of
those — a `<ref>`, `--pr`, `--since`, any other word or option — is still read as that command
through 0.3.3; the last section keeps those spellings and their bytes.

## Synopsis

    team check [--session <name>] [--file <path>]

## Who the check answers

The caller decides, not the flags. Three callers get the answer:

- **the owner**, from a terminal outside herdr — the same walk `status` and the changing
  commands make. An owner **without a terminal** is not this caller: a script meets the fixed
  sentence below;
- **a seat of the team being checked** — placed in the file's session, on the pane the state
  records for it. A seat the state records no pane for, or records on another pane, fails
  closed;
- **a pane outside the team that the approved file names** in its `delegates` entries — through
  the same gate the changing commands use, minus the command list and the audit line: the check
  is a read, not an act.

Anyone else gets one fixed sentence and nothing else, whatever failed underneath — no file, an
invalid one, a refused approval, a state that can't be read, herdr not answering, an aimed
flag, any caller detail:

    team check: this team is not yours to check

The walk that decides it reads the processes above the call — a guard against a mistaken agent,
not a hostile one, so a caller that forges the owner's placement is a known limitation, being
hardened.

`--file` and `--session` are the owner's. Aimed by a caller that passes the gate but is not the
owner, each meets the refusal every command gives it (`--file is the owner's, from a terminal
outside herdr; this call is …`) and exits 1. For every other caller the two flags aim nothing
and open nothing: the target is the file the caller's own place finds.

## What it reads

- the team file, as [`team status`](status.md) loads it — a plain folder's own
  `.agents/team.yaml` through the fallback, no git step;
- the approval store: the record, its copy, and the file against it;
- `team.state.json`: the seats' stages, waits, rules and launch identities, the worktrees, and
  the session's watch;
- herdr, read-only, through the same reads status makes, narrowed to one pass over the panes
  this project's state records for this team's seats: a pane the state records for another
  session, another project or nobody at all is not read. The narrowing is what the file and the
  state say, not a guarantee — a caller with a folder of its own can have the gate admit it on
  that folder's terms — but the disclosure is bounded all the same: no more than what `status`
  already discloses to the same caller, and of a screen only its kind — the watch's own fixed
  words for it, read through the watch's own screen reader. Nothing of the watch's pass, report
  or nudge path runs: no key is sent, no pane is typed into, no memory is written.

It writes nothing at all — not the state, not the store, not the `last_valid` copy `status`
keeps beside the file it read — for every caller, the owner included.

## Output

One line per finding, its repair under it, then the closing count; the check prints no seat
table, no budget block and no notes:

    difference: claude-beacon is in the file and is not running
      repair: the owner runs team up
    team check: 1 difference(s), 1 for the owner

The closing line counts the differences and, after a comma, how many of their repairs are the
owner's. With nothing to act on it is `team check: nothing wrong`.

Under either answer stands the one line that names what the check cannot see:

    not known: work sent and unread, a lead waiting on a seat, a landing not recorded

The readers are agents too, so this text is the contract: one `difference:` line per finding,
its `  repair:` line under it, the closing count line, and the `not known:` line. A finding
never quotes a seat's screen text beyond the profile's fixed words for the kind of screen it
is.

## Exit codes

- `0` — nothing needs acting on.
- `1` — something needs acting on (the findings are printed), or a flag the caller may not aim.
- `2` — the check can't run (the loader's, the state's or herdr's own text), the invocation
  can't be read, or the caller may not check this team (the one fixed sentence).

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

The team runs as the file and the state say, so there is nothing to act on:

```console
$ team check ; echo "exit $?"
team check: nothing wrong
not known: work sent and unread, a lead waiting on a seat, a landing not recorded
exit 0
```

A seat of the team runs it too, and reads the same answer:

```console caller=claude-beacon
$ team check ; echo "exit $?"
team check: nothing wrong
not known: work sent and unread, a lead waiting on a seat, a landing not recorded
exit 0
```

With the herdr session down, both seats are in the file and not running — the summary counts
them, and one repair is the owner's:

```console herdr=absent
$ team check ; echo "exit $?"
difference: claude-keeper is in the file and is not running
  repair: the owner runs team up
difference: claude-beacon is in the file and is not running
  repair: the owner runs team up
team check: 2 difference(s), 2 for the owner
not known: work sent and unread, a lead waiting on a seat, a landing not recorded
exit 1
```

An agent outside the team — no terminal, no seat, no approved pane — learns nothing but the
one sentence:

```console caller=agent
$ team check ; echo "exit $?"
team check: this team is not yours to check
exit 2
```

When herdr doesn't answer at all, an authorized caller gets herdr's own line and nothing is
guessed:

```console herdr=none
$ team check ; echo "exit $?"
team check: herdr doesn't answer; is it installed and running?
exit 2
```

## The old spelling, still read through 0.3.3

A `<ref>`, `--pr`, `--since`, an unknown option or any other word makes the line the old
spelling: the commits half runs as [`team commits check`](commits.md) has always run, with
`--pr` the pull request body's half as well, and one line goes to standard error first for each
half that runs:

    team check: `team check` is now `team commits check`, and is still read through 0.3.3
    team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3

Every line under the notices names the new command, and the exit codes are the ones
[`commits check`](commits.md) and [`pr check`](pr.md) have. A refused invocation — a missing or
doubled `<ref>`, an unknown option, a missing value — keeps the bytes it always had and takes
no notice: an error already says what to fix.

```commit
Tidy the logs

The reader printed one line too many, so the reports carried noise.

Claude-Session: 8f21c4a9
Agent: Claude Opus 5.5 · implementer
```

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

An invocation that belongs to neither spelling refuses in the old bytes and takes no notice:

```console
$ team check --nope ; echo "exit $?"
team check: unknown option --nope

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
