# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-04

A feature release: the budgets table falls back per window and names the source each figure was
counted from; `team doctor` runs each account's approved budget check; `overrides.yaml` teaches a
shipped profile new dialog and quota patterns without waiting for a release; and every typing path
reads the input row from the captured frame and its prompt column, pressing Enter only when the box
reads back as exactly the typed text. Upgrade: a seat with no label is titled with its model and
version, and `team down` now clears the session it stopped.

### Security

- **In 0.1.2, a quota figure could be read off a pane the seat's CLI had already left.** herdr
  keeps a pane listed after the CLI exits, and a shell's last row is a last row by position, not a
  status row, so a status-shaped line under the recorded exit screen folded a figure into the
  readings and the watch saved it. A figure now reads only off a pane whose foreground processes
  still hold the seat's `cli`; a pane herdr can't list keeps its figure — not knowing is not proof
  the seat left.
- **In 0.1.2, a shell line containing a middot under a rule passed for Claude Code's status
  footer**, so a shell prompt could read as an idle composer when the box's top rule was out of the
  window. The footer rows are now anchored to Claude Code's own status rows, declared by the
  profile.
- **In 0.1.2, one indented line shaped like Claude Code's status row, or its mode row, under a rule
  below a shell prompt read as an idle composer.** A box whose top rule is out of the window is now
  recognised only by both rows, in order.
- **In 0.1.2, a Cursor seat with its follow-up queue on screen read idle or as holding unsent
  text**, so `down` could type `/exit` into a running seat and `remove` refused it as unsent. The
  queue's hint row under the empty composer belongs to the running turn; the profile now reads any
  spinner verb and that row (with nothing but chrome under it), so `down --wait` waits and `remove`
  says the seat is working.
- **In 0.1.2, delivery pressed Enter as soon as the composer read as unsent text, whatever the box
  actually held** — a fold marker whose hidden-row count could not be right, a box still holding a
  person's own text, and the typed text with one character changed all got the Enter, so text that
  was not the rules could be submitted as if `team` had sent it; the watch's nudge and the exit
  typed by `down` and `remove` pressed Enter on an unread box the same way. Every Enter now waits
  until the box reads back as exactly the text typed — folded or not, row for row — and a box whose
  wrap the profile's data cannot model gets no Enter at all: the wait ends in a refusal that reports
  the rules were not delivered, never an Enter on trust.
- **In 0.1.2 the composer's input row was the last row whose content began with a prompt glyph, and
  the fold frame ended on the first rule-looking row** — pre-existing holes, present in every
  release before this one too. A box holding a person's text and then a continuation row with only
  the CLI's prompt glyph read idle, the read-back held, and the Enter submitted the person's text
  with the team's; a rule row after the true tail still got the Enter. The input row is now read
  from the captured frame and its prompt column: for Claude Code and Antigravity, the box's first
  row under its opening rule; for Codex and Cursor, the column their captures draw the prompt at,
  where a continuation row as those CLIs draw it — indented — is content, so the person's text
  above it stays in the box. A row carrying the glyph at that exact column — a shape no capture
  shows those two CLIs drawing — is read as the input row, and a person's text left above it is not
  read. The box's fold is read the same way: its closing rule is the window's last rule row at the
  opening rule's own width, a rule-looking row anywhere else is a row of the box, and where the
  frame cannot be told the read fails closed and nothing is entered.
- **In 0.1.2 a two-rule frame was read without comparing its rules' widths** — pre-existing too,
  present in every release before this one. The composer's frame is read only when its two rules are
  one width, as every capture draws them: where a window's rules differ — a closing rule that is not
  the opening rule's own width — the box cannot be established, the read is unknown, and nothing is
  entered.

### Added

- `team doctor` runs each account's approved budget check once, for the owner only, and reports its
  reading, a broken output contract, a failure or a timeout; a check edited since approval is not
  run and is reported as changed. It also lists accounts no pattern or check can read. The check's
  raw output is never printed.
- `overrides.yaml`, beside the approval in `~/.config/team/<project>-<hash>`, may add dialog
  patterns and quota patterns to a shipped profile. `team approve` records it. Until then the
  approved copy stays in force, and `doctor` and `status` name the change.
- `schema/team.schema.json` describes the team file (draft 2020-12), assembled from the same
  section modules that validate it, with `schema:check` in CI keeping it current. The schema ships
  in the package, and a file `team init` writes now opens with a
  `# yaml-language-server: $schema=…` line pointing at this version's copy.
- `docs/reference/cli.md` is a generated CLI reference — every command, flag and positional, from
  the command definitions themselves — kept current by `contract:check`, with the same snapshot as
  data in `contract/cli.json`. Help text is unchanged.
- `bun run conformance` checks an implementation of screen reading and the YAML subset against the
  shared fixtures. `team conformance-adapter` is the TypeScript implementation of that protocol. It
  is not listed in `team --help`.
- `bun run coverage` prints the capture coverage matrix — for each CLI and screen kind, how many
  conformance fixtures are real captures, constructed, or with no provenance stated — and
  `coverage:check` keeps `contract/capture-coverage.json` current in CI, failing on a difference or
  any provenance problem. Only the fixture folder's README decides: a `capture` claim counts where
  the README lists the file under a heading that is not Constructed or Not produced.
- A profile may give a dialog pattern its own `ignore_case: true` beside its `match` — the flag
  reaching its `except` list too. Claude Code's trust question, spelled out in both cases letter
  class by letter class through 0.1.2, is now one line with the flag on it, and the "1. Yes" choice
  beside it stays matched as it is drawn. A composer's own patterns — `prompt`, `rule`, `footers`,
  the status line, the suffix — take strings; a flag written among them is refused at load with the
  key's name (`"prompt" cannot ignore case: only a dialog pattern may`).
- A profile may name a `screen_module` — a code module inside the package's profiles folder — for a
  CLI whose screens the data rules cannot express. Its predicates are combined with the data rules
  by OR for `working`, every dialog stage and `unknown`, so a hatch can only add caution, never
  remove it; a composer comes from data or from the hatch, never both, and a profile that carries
  both is refused when it loads. No shipped profile uses one. The guarantees cover what a hatch
  returns and what load accepts; a hatch is trusted package code, not a sandbox.

### Changed

- A seat with no label is titled with its model and version in lowercase (`claude opus 5.5`). A
  label written in the file is kept. Two seats may share a label — names are the only key — and an
  approval recorded by 0.1.1 or 0.1.2 stays valid while the file is unchanged since that approval.
- `team doctor` warns when a seat's name or label repeats the project or the session. The warning
  does not refuse the file.
- The budgets table names the source each figure was counted from and marks it `(fallback)` when
  that is not the first source the account names — `status line (fallback)` — and `status --json`
  carries the same `fallback` field on each budget row. The fallback is per window, not per
  account: a check that reported one window leaves the other window to the next source the account
  names.
- A stale figure with no known reset time reads unknown only while it could still matter: inside
  its reserve, or within the reserve again outside it. Beyond that it still counts, its row saying
  `last seen <age>` — the room the figure last held. It never refuses a launch.
- **`team down` now clears the herdr session it has itself just stopped**, its line reading
  `stopped and cleared`, so `up` after `down` starts the team again instead of refusing on the
  stopped session herdr keeps listed; where the clear does not happen the line names
  `herdr session delete <session>`. `up` never deletes a session: one it did not stop keeps the
  refusal.

### Fixed

- Claude Code's folder-trust dialog with unnumbered choices is read as a trust prompt, not a
  question.
- `team down` now stops a seat the file renamed after `up` launched it: the state records the CLI
  each seat was launched with, and `down` resolves the file's name first and the state's second,
  falling back to the seat a temporary seat is like. A state too old to say leaves the seat to its
  owner, named per seat with the command that closes it without typing.
- **A pattern's astral code point wrote five hex digits.** U+1F600 compiled as `ὠ` and a `0`, so an
  emoji or an astral range matched the wrong text; they now compile to the `\u{…}` form.
- **A `chrome` pattern could hide the unmarked second choice of a dialog.** The guard tested six
  sample lines, all of the first choice; it now tests the drawn shape — every mark or the indent,
  both numbered lines the safety floor reads, and the labels the profiles name.
- **A check's CRLF output read unknown.** `weekly 39% used\r\n` broke the contract on its line
  ending; each line now loses the trailing CR of a CRLF ending, and a CR anywhere else still breaks
  the contract.
- **A class mixing a complement shorthand with members was silently rewritten.** `[\D0-9]`
  compiled to `[\s\S]`; the positive class is now refused with the reason when the profile loads.
  `[^\S\n]` and a shorthand alone are unchanged.
- A temporary seat now follows the drift of the seat it is like, folding no figures until
  unapproved edits to the like-seat are approved.
- **An Antigravity seat's rules are delivered when agy folds the paste.** A long paste folds to
  `↑ N more lines` and the tail; the box is now read as folded, and Enter is pressed only when the
  visible tail rows and the hidden-row count are the ones the typed text renders to. A fold that
  doesn't match stays unsent.
- **A spend refusal rounded the figure it printed, into a contradiction with itself.** A reading of
  `4.996 USD` against a `5 USD` floor printed "5.00 USD, at or below its 5.00 USD floor"; the
  figure now prints as read — up to four decimals, the trailing zeros beyond the cents dropped,
  never fewer than two — in the refusal and the dry-run lines that reuse it, and a floor prints as
  the file wrote it.

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

[0.2.0]: https://github.com/floor/team/releases/tag/v0.2.0
[0.1.2]: https://github.com/floor/team/releases/tag/v0.1.2
[0.1.1]: https://github.com/floor/team/releases/tag/v0.1.1
[0.1.0]: https://github.com/floor/team/releases/tag/v0.1.0
