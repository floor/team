# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-04

A safety release: 0.1.1 could type a nudge or an exit into the shell left after Claude Code exited,
and a seat could silence the watch's reports about itself. Upgrade.

### Security

- **In 0.1.1, a shell prompt left after Claude Code exited read as an idle composer**, so a nudge, a
  first message or an exit could be typed into a shell. A composer now reads idle only inside its
  own frame — the rule above the box or the status footer under it — and every typing path (the
  nudge, rules delivery, `down`'s and `remove`'s exit) also needs herdr to report the agent's
  process in the pane, read again immediately before the Enter.
- **In 0.1.1, parking or stopping a seat was not drift**, so a seat could silence its own idle
  reports by editing its entry in the file. Parking and stopping are now part of what the owner
  approves; `remove --keep` and `add` record the new digest when `stopped` is the only change, so
  those commands still leave that file approved, and an approval recorded before this stays valid
  while the file is unchanged since the approval.
- **In 0.1.1, `--no-notify` on the watch silenced a report addressed to the owner**, and any caller
  could run the session's only watch with it. Each report is now routed to the owner or the
  operator, and `--no-notify` drops only the operator's notice — the log line stays, and
  `team status` does not read the flag. The watch's own notices — the operator could not be
  nudged, herdr does not answer, the file cannot be read, a typed nudge was not sent, the watch
  stopped — are the owner's and survive the flag too. `--no-nudge` and `--no-notify` are the owner's.
- **In 0.1.1, a watch on a session other than the file's own saved its readings into the state a
  launch gate counts.** Such a watch now reads and reports as before, says so once, and saves no
  reading — budget or spend — so a session the file doesn't name can never decide a launch.

### Added

- A seat may name the budget account it spends, `account:`, when one vendor's two accounts are two
  buckets; without it a seat spends its `vendor`, and the choice is part of the seat's fingerprint,
  so the owner approves it. It must be a key of the file's `budgets.accounts` — a name the budgets
  don't hold is refused where it is — and an unapproved edit to it folds none of that seat's figures
  until the owner approves. A figure measuring the seat's vendor lands on the seat's own account,
  and a figure naming another account stays that account's, whichever seat's screen showed it.

### Changed

- While a `watch.checks` edit is unapproved, the approved list stays in force: nothing new is turned
  off, and an approved-off check stays off. Before, every check ran until the owner approved.
- **A seat could take the rules message for a task.** Every seat's rules text now ends with a line
  saying the rules are not a task. A first message closes with `These are standing rules, not a
  task: reply ready and wait for your brief.`; a launch option that stays in force on every later
  turn (claude-code's `--append-system-prompt`) closes with only `These are standing rules, not a
  task.` A team file whose own `rules:` already end with that line doesn't get it twice.
- A team whose seats were stopped by `remove --keep`, or parked by hand, since its last approval
  shows `seat X changed` for each after upgrading, and `up` and `add` refuse until the owner
  approves once.

### Fixed

- A greyed suggestion in a Claude Code input box is no longer read as text that was never sent:
  input text whose characters are all faint is the box's placeholder, and the seat reads idle. Text
  with any other styling reads as unsent text, and a line with no styling keeps the `Try "` rule.
- Cursor's running turn is the braille spinner, or the prompt line that ends in `ctrl+c to stop`.
  The same words quoted in the transcript are not a turn, and text typed on that prompt is unsent in
  the composer.
- A subscription check reading is kept in the state beside the screen readings, and `up`, `add` and
  `status` count it: a fresh check inside its reserve refuses a launch after the watch has exited, a
  stale one outside its reserve reads unknown, and the account's `sources` decide which reading counts.
- Budget readings are kept per project, not per herdr session: `up`, `add`, `status` and the watch
  read the one cache, so a figure one session saw counts for every session, and state files written
  before this change migrate as they are read — no reading is lost.
- A stale check reading inside its reserve keeps refusing until its known reset, as a stale screen
  reading does; an unconfirmed screen reading no longer hides a fresh check reading later in
  `sources`.
- A Claude question is the dialog's own last line. Prose that says "Esc to cancel", and a transcript
  of "1. Yes" / "2. No" above an empty box, stay idle.
- An Antigravity permission dialog whose rule line has scrolled out of the window (a long command)
  is still read as the dialog, and a Claude Code question with a line below its footer and no rule
  in the window is still read as a question.
- The watch folds its readings inside the state's own lock, so two watches of one project fold onto
  each other's figures instead of overwriting them.

## [0.1.1] - 2026-10-04

A safety release: 0.1.0 could type into a Codex permission dialog, and could read a quota figure a
seat wrote itself. Upgrade.

### Security

- **In 0.1.0, `team` could answer a Codex permission dialog.** With the status line pinned below
  the dialog, the screen read as unsent text, so rules delivery and the watch's nudge typed their
  text and Enter into it, accepting its first choice. The dialog is now read as the dialog: the
  safety floor's markers match without regard to case, and a rule's footer may sit above a
  `status-last` composer's pinned line. The dialog is reported and never answered, and rules
  delivery and the watch type nothing into it.
- **In 0.1.0, a seat could set its own quota figure** by printing or typing a line shaped like one,
  which could keep a launch from being refused. Quota figures are now read only from the status
  line's own row of a composer screen: a line printed into the transcript or typed into the input
  box is not read as one, a CLI whose composer shows no status line reads no figures at all, and a
  dialog, a question, a trust or an unknown screen reads none. A pane's owner can still draw a whole
  fake composer; a fresh `check` reading stays first, and a wrong figure can only refuse a launch or
  produce a report.

### Added

- A spend account's `floor` refuses a launch: the watch keeps the money each spend check reads in the
  state, and `up` and `add` refuse a seat whose account is at or below its floor. A reading that is
  missing, stale or in another currency than the floor's reads unknown, is said, and never refuses.

### Changed

- `bun run build` empties `dist/` first, so a file left by an older build can no longer end up in a
  packed or globally installed tarball.

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
- Codex's profile reads a weekly quota from its status line: `weekly N% left`, for the OpenAI account.
  A line cut short of the number is not a figure.
- `budgets` is an owner section: marks, freshness, and each account's reserve or floor. A `check`
  command is resolved and hashed at `team approve`. `watch.quota_marks` is read, with a warning.
  A changed check file leaves that account unknown; it does not refuse the rest of the file.
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
  A timing a seat changed without an approval shows its difference at the next pass, for the owner
  to settle. A never-approved team runs on the defaults, whatever its file says.
- The whole `budgets` section is an owner section too, its accounts and marks included: an edit to
  a reserve, a floor, `stale_after`, `check_every` or the accounts needs a new approval, and until
  the owner approves it every reader — the watch's reports and its check cadence, the check
  commands' own run, `up`'s and `add`'s launch gate, and `status`'s table — runs with the values of
  the approved copy, or with the defaults (no accounts) when nothing was approved. A file never
  approved runs no check at all. An unapproved edit silences nothing and unblocks nothing.

### Fixed

- A seat that isn't `mode: shared` and works in worktrees starts in the lobby — the parent of
  `workspace.path` with `.lobby` beside the worktrees, inside `trust` and outside every protected
  checkout — never the project root, which holds the owner's uncommitted work; `up` and `add` make
  it once, refuse a lobby outside `trust` or inside a protected checkout, and refuse a seat the file
  aims at one. (#35)
- Claude Code's permission stage is the dialog itself: the question with its "Esc to cancel · Tab to amend"
  footer, or a Yes/No choice below the last rule. An idle seat that only quotes "Do you want to proceed?"
  stays idle.

[0.1.2]: https://github.com/floor/team/releases/tag/v0.1.2
[0.1.1]: https://github.com/floor/team/releases/tag/v0.1.1
[0.1.0]: https://github.com/floor/team/releases/tag/v0.1.0
