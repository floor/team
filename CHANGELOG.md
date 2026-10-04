# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Codex's profile reads a weekly quota from its status line: `weekly N% left`, for the OpenAI account.
  A line cut short of the number is not a figure.
- `budgets` is an owner section: marks, freshness, and each account's reserve or floor. A `check`
  command is resolved and hashed at `team approve`. `watch.quota_marks` is still read, with a warning.
  After upgrading, the owner runs `team approve` once. A changed check file leaves that account
  unknown; it does not refuse the rest of the file.
- A quota figure is kept per seat in the state file. The newest confirmed change counts. A first
  sight does not replace it, and a reading from before its reset is dropped.
- `team status` prints a budgets table, and the same rows in `--json`, when an account is named or
  a reading is stored. Unknown and stale are shown as such. A row inside its reserve says so even
  when the figure is still fresh.
- `team watch` reports a budget: each mark a window crosses, an account inside its reserve or floor
  (to the owner), and an account that reads unknown while seats run on it (to the operator). The
  accounts' check commands run in the watch loop, outside the pass: at most every `budgets.check_every`,
  ten seconds, an empty environment, and only when the approval covers them — their output is never
  logged. The core parses each seat's quota line, and a reading the pass saw is saved, so `status`,
  `up` and `add` count it. `watch.checks: { budget: off }` turns the report off.

### Changed

- The whole `watch` section is an owner section, its timings included: an edit to `interval`,
  `idle_first`, `idle_repeat`, `team_idle`, `nudge_wait` or `unsent_after` needs a new approval, and
  until the owner approves it the watch runs with the values of the approved copy — or with the
  defaults when nothing was approved. `watch.checks` keeps its own finer line inside the section.
  An approval recorded before this change stays valid while the section is unchanged; a timing a
  seat changed without an approval shows its difference at the next pass, for the owner to settle.
  A never-approved team now runs on the defaults whatever its file says.

### Fixed

- Claude Code's permission stage is the dialog itself: the question with its "Esc to cancel · Tab to amend"
  footer, or a Yes/No choice below the last rule. An idle seat that only quotes "Do you want to proceed?"
  stays idle.

## [0.1.0] - 2026-10-04

The first release: set up, change and watch a project's team of AI agents from one file,
`.agents/team.yaml`. Runs on Node 22 or later, with no runtime dependencies.

### Added

- The team file: a documented YAML subset with its own parser, validated field by field with line
  numbers, and a fictional example at `examples/team.yaml`. (#2, #11)
- `team init` and `team status`: write the skeleton file and keep it out of git through
  `.git/info/exclude`; print the file's seats against the running session, each difference with its
  repair; `--json` prints the same facts as one JSON document (`format: 1`) for scripts. (#3, #33)
- A seat whose own status line names another model than the file's is a status difference, with its
  repair; a model id the map doesn't know, or another maker's model run through Claude Code, is
  unread — a note, never a difference. (#30)
- `team approve`: record the file, its ceilings and its seats on this machine after a read-back and
  a typed seat count; `--show` prints the approved copy. (#4, #5)
- `team check`: check one commit, a range or a pull request body against the signature rule;
  forbidden lines and session links are refused by default; it runs on every pull request in this
  repository's CI, against the repository's own team file and the seats that sign its history.
  (#1, #8, #12)
- `team doctor`: check this machine for what the file needs — herdr, each CLI, login, launcher,
  model, watch heartbeat; `--login` checks read-only that each declared CLI is signed in, using each
  profile's login check, and answers no prompt. (#5, #33)
- `team watch`: report idle and blocked seats, unsent input and machine figures, and nudge the
  operator only into an empty idle prompt; `--no-nudge` and `--no-notify` turn those off. (#6, #7,
  #22)
- Linux: the caller check and the watch's load, memory and swap figures are read from `/proc`, so
  `team` answers there as on macOS. (#29)
- A stopped seat its owner starts by hand is watched like a parked one: prompts and unsent text are
  reported, its idle is not, and it is never read as an agent the file doesn't hold; parked and
  stopped follow RFC 0001. (#25)
- `team up` and `team down`: start and stop the session and its seats, each with its caller rule;
  staged launches, a wait for an empty idle prompt, trust and update screens read and never
  answered; `--dry-run` prints the plan and changes nothing. (#5, #13, #14)
- `team up` and `team add`: every `machine:` start limit — load, memory, disk, free swap and swap
  growth — is checked before each seat, and a breach refuses the launch, naming the figure and its
  limit; a `--dry-run` prints the refusal too. (#26)
- Launch profiles for `claude-code`, Codex, Antigravity and Cursor: approval flags added only at
  launch, rules delivered only into an empty idle prompt, screens read from recorded, sanitised
  fixtures; a Codex permission dialog is reported for its owner and never answered. (#16, #17,
  #18, #23, #24, #27)
- `team add` and `team remove`: start one declared or temporary seat; stop a seat, then take it out
  of the file — `--keep` leaves it stopped, `--abandon` is the owner's. (#19, #20)
- `team worktree new` and `team worktree remove`: create a task worktree from an up-to-date base, or
  remove its folder; a failed setup is kept and recorded, and the branch is never deleted. (#15)
- A README that covers the file by example and every command with who may run it. (#9)
- A page per command in `docs/commands`, every example run in CI. (#31)

### Fixed

- A seat that isn't `mode: shared` and works in worktrees starts in the lobby — the parent of
  `workspace.path` with `.lobby` beside the worktrees, inside `trust` and outside every protected
  checkout — never the project root, which holds the owner's uncommitted work; `up` and `add` make
  it once, refuse a lobby outside `trust` or inside a protected checkout, and refuse a seat the file
  aims at one. (#35)

[0.1.0]: https://github.com/floor/team/releases/tag/v0.1.0
