# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watchdog pane that runs `team watch`. Seats already ready
are left as they are; a seat stopped in the file is left out until `team add` starts it. `--dry-run`
prints the plan and runs nothing.

A session stopped in herdr is refused until its owner clears it — `up` never deletes a session. A
session `team down` stopped needs no such step: `down` clears the one it stopped in the same run, so
the next `up` starts from the beginning.

Every seat, shared and worktree-mode alike, starts in `~/.config/team/lobby`. It is shared
by all projects on the machine. Before creating anything, `team` verifies the lobby gate:
ownership by the invoking user, no symbolic links anywhere in the chain, directory mode exactly
`0700`, empty, and not inside a git repository or worktree. The launch uses that verified
path. The lobby is checked again — the gate's checks, plus that it is still the folder the gate
read: the same canonical path, device and inode — directly before every workspace this run creates
in it, with nothing between that confirmation and herdr's create call. A failed confirmation
creates nothing: the seat is left out with the gate's cause in words — the gate's own line, the
folders it resolved, is written under the record on stderr — and the rest of the
launch stops, so no further workspace is made, not even the watchdog's. A seat created earlier
in the same run is left running: its workspace was created while the path was the verified
lobby, and `up` never closes a workspace it may already have started a CLI in. One window
remains, inside herdr itself: the create call takes a path, not an open folder handle, so herdr
resolves that path in its own process after the confirmation.

A seat goes to its real folder itself: a worktree seat to the worktree its brief names; a shared
seat to its configured `cwd` before any project work.

The lobby is a folder no CLI has seen before, and `up` reads a trust question and never answers one:
the first `up` leaves each seat out with `<seat>: left out: trust`, and the detail under the record
says its workspace was closed without an answer — nothing run — until the owner trusts
the lobby once in that CLI. Then it starts.

## Synopsis

    team up [--dry-run] [--session <name>] [--file <path>]

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store, the session's state
(`.agents/team.state.json`, for each seat's stage), herdr (whether the session is up, its agents and
workspaces), the doctor's findings, and the machine's load, free memory, free disk and free swap.
Writes `.agents/team.state.json` (each seat's stage, pane, workspace and the CLI it was launched
with; the watch's pid and heartbeat), `.agents/team.log`, the machine lobby folder
(`~/.config/team/lobby`) every seat starts in, and, through herdr: the server, one workspace per seat
and one for the watchdog, each seat's launch, and the watch.

## Who may run it

The owner, from a terminal outside herdr. `--dry-run` is open to anyone: it reaches nothing and
changes nothing, prints the refusals it would hit as `! up would refuse: …` above the plan, and
exits 0.

## Flags

| Flag | Meaning |
| --- | --- |
| `--dry-run` | print the plan, and the refusals the real run would stop on, and exit 0 |
| `--session <name>` | the herdr session to start, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

One record per seat, in the file's order, is the run's whole account of that seat:

    claude-keeper: ready
    claude-beacon: ready

A seat that reaches its idle prompt with its rules delivered prints `<seat>: ready`. A seat left out
prints `<seat>: left out: <what stopped it>` — a classification (`trust`, `permission`, `question`,
`vendor notice`, `login`, `unknown`, `unsent`, `timeout`) or the reason in the seat's own words, in
the table below. On a terminal the line is drawn before the seat's workspace is created, as
`<seat>: launching`, and rewritten in place as the seat advances — `waiting for its prompt`,
`naming`, `sending its rules` — until its one final record ends the line with a newline. A
redirected stdout receives the final records only: one newline-terminated line per seat, nothing
provisional, no escape sequence. Everything else a run says about a seat — the indented detail
under the record, the `skip` line for a seat stopped in the file, a note, a timeout's last reading
and the pane's last lines — is written to stderr, after the record it belongs to; a seat on a CLI
with no launch profile prints the `left out` record above, on stdout. `watch: started` is on stderr
too.

A seat already ready is left as it is, and the words it was left with are the detail under its
record. A ready seat the state records without its process identity, or with a start outside the
machine lobby, is left as it is too — only a relaunch repairs either — and its detail says so:
`  already ready; left as it is; a relaunch records its process: team remove <seat> --keep, then
team add <seat> (or team down, then team up, for the whole team)`, or the same words saying `a
relaunch moves it into the lobby`. For a seat the file names as coordinator or operator, the detail
offers only `team down, then team up (to restart the whole team)`.

A seat is its pane only while the process `team` launched is still in it. A seat the state records
whose pane no longer holds that process is not "already ready": its workspace is closed without a
key and without input — its pane runs no CLI, or one team did not launch, and nothing in it is the
seat — and the seat is launched fresh with its rules. Its record is `<seat>: ready`, and the detail
under it says both: `  its pane held no CLI; closed without input and launched again` when the pane
was back at its shell, `  its pane held a process team did not launch; closed without input and
launched again` when another process held it.

The reading that decides the repair is taken while the plan is built, and the close can be minutes
later, after every seat before this one was created, waited for and delivered to. `up` reads herdr
again immediately before it, with nothing between those reads and the close, and closes only a pane
that is provably still the seat's stale one: the agent list must name this seat on the recorded
pane, that pane's workspace as herdr reports it now must be the recorded workspace, that workspace
must hold no other panes (named or not), the process reading must still say the pane runs no CLI or
another process, and a pane held by another process must not read `working` or `unsent` — a process
that is working or holds unsent text is never closed by `up`, whoever started it.
When any of that does not hold, nothing is closed, nothing is launched for that seat, its state is
left as it is, the seat is out of the run, and `up` exits 1 with one record:

| Record | When |
| --- | --- |
| `<seat>: left out: its pane is the seat's again; left as it is` | the pane now holds the recorded process — its owner restarted the CLI between the plan and the close. Not an error: the seat is skipped as ready and the exit code is unaffected |
| `<seat>: left out: herdr no longer shows this seat on its recorded pane; nothing closed; run team status` | the agent list no longer names the seat on the recorded pane, or that pane's workspace is no longer the recorded one |
| `<seat>: left out: its workspace holds other panes; nothing closed (close its pane there, then run team up)` | herdr's pane listing for the recorded workspace holds more than the seat's recorded pane |
| `<seat>: left out: the process in its pane is working; nothing closed (stop it there, or run team remove <seat>)` | a process team did not launch holds the pane and its screen reads `working` |
| `<seat>: left out: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove <seat>)` | a process team did not launch holds the pane and its screen reads `unsent` |
| `<seat>: left out: its pane could not be read; nothing closed` | herdr can't give the workspace's panes, the pane's processes, or its screen reads as nothing this version knows |

This comparison is wrong in the safe direction, but it is wrong: a CLI that replaces its own
process — an updater that re-executes, a wrapper that hands over — changes the foreground pids, and
the seat then reads `restored, not launched by team` although nothing was restored. `up` closes
that pane without input and launches the seat fresh, and the conversation in it is lost. The record
holds every pid the launch left in front, and accepts the seat while **any** recorded pid is still
there; no reading of a CLI after its first message was taken when this record was made, though a
review's runs of a CLI with a helper beside it and of one behind a pipeline kept every pid. Before
running `up`, the owner looks: `team status` names such a seat, and the pane itself says whether
the CLI there is the one `team` launched.

When the workspace does not close, nothing is launched in its
place and the seat is left as it is:
`<seat>: left out: its workspace did not close; left as it is`, with `up` exiting 1. A seat with no `launched`
record in state (one launched before this version recorded process identity, or one stopped at a
dialog before its idle prompt: the reading is taken once, after the idle prompt and after the launch
model check) keeps today's behaviour: nothing checks its pane. (An `up` run without a terminal closes
a waiting dialog's workspace without input and prints `left out`; interactive handling of waiting
seats and `trust-sent-recovery` at a terminal, alongside recording process identity before an idle
prompt, is a separate planned change and is not altered here.)

When the idle screen names no model this version can read, `up` writes `<seat>: its screen doesn't show a model this version knows; not checked` to stderr, after the seat's record, and continues. It is detail, not a record: the log keeps the seat's one line, the record `ready`. Nothing is assumed about which model is running.

A seat whose rules travel as a first message (codex, cursor, antigravity) gets them from a file:
`up` writes the approved rules text to `<project state folder>/rules/<seat>.md` — owner-only,
mode `0600`, beside the approval store, never inside a worktree, the lobby or the project — and
types one line into the pane at an empty idle prompt:

    Read /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.

The state folder is resolved from the **approved copy's** project name, through the one resolver
the writer, the line, the hash check before Enter, `status`, `doctor` and `remove` all use: a
project rename is not approval drift, and the line a seat is told to obey must name the file the
checks look at, not one resolved from the live file's new name.

The line carries the file's absolute path and the first 12 hex digits of its SHA-256, so the
seat — and the read-back — can tell exactly which text is meant. A path that holds whitespace or
a character outside letters, digits and `. _ / @ + -` is never typed: nothing is quoted or
escaped, and the report says the path can't be typed safely. The line is read back row by row —
every visible character in order, a row break allowed to stand for at most one space or nothing —
and only then is Enter pressed, once. A box that already holds exactly today's line (a run that
stopped after typing it) is verified and sent, never typed onto again. `up` never clears a box it
could not verify: a stop leaves the text where it is.

### Known limits

- The final read of the box and the pressing of Enter are two separate `herdr` calls. Something
  can change the pane in the gap between them; `team` reads the pane again right before the
  Enter, but it cannot make the two one action. Closing that needs a key herdr itself does not
  offer today.
- A row break may hide at most one space, and no read can prove what a pane folds into a break:
  the check requires every other visible character to match exactly, and refuses anything looser
  rather than guess.
- The file is read once more, without following a link, directly before the Enter — but a
  process of the same user can still replace the file between that check and the seat's read.
  The line carries the file's hash, so the seat, or the owner, can check what was read against
  what was meant.
- Every folder from `team`'s state root down to `rules/` is checked before it is used — but the
  check and the use are two calls, and a process of the same user can swap a checked folder for a
  link in the window between them, so a folder of the ladder, or the file itself, lands where the
  link points. The runtime this runs on offers no way to hold the checked folder open and create
  the next level through that handle, so the window stays open. What limits it: the write is the
  approved text and nothing else, through an exclusive no-follow temporary whose name no other
  process knows, the file is read back by its hash after the rename, and the line the seat
  receives carries the same hash — so whatever lands wherever it lands can always be checked
  against what was meant, and nothing but the approved text ever lands anywhere. The removal
  of a temporary seat's rules file walks the same checked chain as the writer, folder by folder
  and without following a link, before it unlinks anything — so its window is the writer's own
  and no wider.

A seat that doesn't get there prints its one record with what stopped it, and `up` exits 1. For a
seat whose wait ended without a prompt, the record is `<seat>: left out: timeout` (or the
ended-at-its-shell reason below), and the detail under the record, on stderr, carries the last
non-empty lines the pane showed — the launch line's own
echo first when it is within reach, six at most, every escape sequence and every control character
but the line breaks removed, each line cut to 200 characters with `…` — each on `  | `;
`  run \`team up\` again to resume it` names how the seat is finished.
Those lines go to the terminal only: the log file gets the record, never the screen's text. The
same holds for every folder the run resolves: a refusal's record holds the finding in words — the
start folder a launch line was looked for in, the lobby a failed confirmation names — and the
sentence with the folder is written under the record, on stderr, for this terminal alone. One line
per final record, in file order, plus the watch's own line — `watch: started`, or `watch:` and its
reason in words when it did not — is the whole of what the log gets: a defect in the seat's file,
or a note like the unread-model one below, is stderr detail and never a log line.

The records are what stdout gets; a line below that is not a record is written to stderr, after the
record it belongs to, as its meaning says.

| Line | Meaning |
| --- | --- |
| `<seat>: left out: trust` | the CLI asked whether to trust the folder, and `up` never answers one; the detail under the record says its workspace was closed without an answer and the seat left out |
| `<seat>: left out: permission` / `<seat>: left out: question` | a permission dialog, or a question, was left for its owner to answer; the detail under the record says its workspace was closed without input and the seat left out |
| `<seat>: left out: vendor notice` | the CLI shows a vendor notice its owner has to act on: a screen its profile captured as one — today, Codex 0.157.0's update screen. `team` never answers one, and treats it at least as strictly as a question: nothing is typed, the watch reports it, and delivery stops on it. The detail under the record says its workspace was closed without input and the seat left out, and adds `untested on <version>` when the CLI installed here is outside the range the notice was captured on — the reading itself is never made less cautious by a version |
| `<seat>: left out: <reading>; its workspace did not close; left as it is` | the close of that workspace failed, with `<reading>` one of `trust`, `permission`, `question` or `vendor notice`: nothing claims it was closed, and the seat is left exactly as it was, its state kept — a later `up` resumes it |
| `<seat>: left out: runs <model> <version>; the file says <model> <version>; left at launched, not named. Add <flag> <id> to its launch, or correct the file's model and version and run team approve` | the idle screen shows a different model than the file. The seat is not renamed and gets no rules; its pane stays open. The flag is that CLI's model flag, and the id is the one the profile maps to the file's model. When the profile knows no id, the line says `<id>` |
| `<seat>: left out: its pane has been back at its shell for <n> s and shows no CLI prompt; left at launched` | herdr's process info says the pane's foreground program is back at its shell through three full polls on end, four readings, the screen matches no CLI shape, and the launch line's own echo is visible on the screen. A pane read before the line arrived, one whose echo scrolled away, one whose program is slow to draw, or a herdr that can't say (no shell process info), is waited out to the deadline — the end is never inferred from the screen's text, and a single reading can never reach the three polls. The workspace is kept, and the pane's last lines follow on stderr, under the record |
| `<seat>: left out: timeout` | the prompt never came within the profile's own time limit; the detail under the record, on stderr, says after how long it waited, the screen it last read, the pane's last lines, and that `team up` again resumes it |
| `<seat>: left out: was not in the agent list in time; left at launched` | herdr listed no agent in the pane to name |
| `<seat>: left out: rules not typed: the folder that would hold its rules file is <what>; the owner removes or repairs it, then runs up again` | a folder from `team`'s per-user state root down to `rules/` is not a real directory of this user's — a symbolic link, not a directory, another user's, or (for `rules/` and the project folder) a mode wider than `0700`, never `chmod`'d closer; `<what>` says which. Nothing was written, nothing typed |
| `<seat>: left out: rules not typed: its rules file's place holds <what>; the owner removes it, then runs up again` | the final name holds anything other than this user's `0600` regular file — a symbolic link, a FIFO, a directory, a wider mode, another owner — and is never replaced; `<what>` says what is there |
| `<seat>: left out: rules not typed: its rules file did not read back as written; check the project state folder, then run up again` | the write landed but did not read back (no-follow) as the hash the line carries; nothing was typed |
| `<seat>: left out: rules not typed: its rules file could not be written; check the project state folder, then run up again` | the write failed; nothing was typed |
| `<seat>: left out: rules not typed: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -; rename the seat or move the project, then run up again` | the path holds a character the read-back cannot prove; nothing was typed, nothing quoted |
| `<seat>: left out: rules not typed: the CLI never appeared as its pane's foreground process (the screen read <kind>); check the seat's launch line — the wrapper it starts through, or the command itself — then run up again` | within the profile's own time limit the pane's foreground process was never the CLI — a wrapper's shell still in front of it, or a launch line that exited. A CLI that starts through a wrapper is waited out, its first frame included; nothing is typed into the wrapper's shell |
| `<seat>: left out: rules not confirmed: the seat is working; run up again when it is idle` | the seat is mid-turn; nothing was typed |
| `<seat>: left out: rules not typed: <what stopped it>; <what to do>` | nothing was typed: the screen was not an empty idle prompt, or the box already held text that is not the rules line |
| `<seat>: left out: rules typed, not sent: the read-back didn't match; the line sits in its box, unsent: <what to do>` | the line was typed and its box did not read back as the line; `up` does not clear it. When the box drew a row that is not the line's own, the first such row is written under the record on stderr, stripped of control characters and cut to 200 characters |
| `<seat>: left out: rules typed, not sent: the rules file changed after it was written` | the line read back, but the file — read again without following a link, directly before Enter — no longer held the text whose hash the line names. Enter was not pressed; the line sits in the box, unsent, and the owner checks the project state folder before running `up` again |
| `<seat>: left out: rules typed, not sent: its box still holds the line after Enter; <what to do>` | Enter was pressed and the box still shows the line: the key did not take, and nothing was sent |
| `<seat>: left out: the seat did not come back to its idle prompt (<reading>); <what to do>` | the line was submitted and the seat never came back to its idle prompt — a running turn, or a dialog to answer |
| `<seat>: left out: its rules were not delivered; left at named` | the pane could not be read at all; nothing was typed |
| `<seat>: left out: its workspace did not close; left as it is` | its pane no longer held the process `team` launched, and closing that workspace failed, so nothing was launched in its place |
| `<seat>: left out: its workspace was not created; left at launched` | herdr made no workspace for it |
| `<seat>: left out: its launch command did not run; left at launched` | the pane took no command |
| `<seat>: left out: the approval allows 3 seats; 4 would be running` | the approval's ceiling, from the record, not the file |
| `<seat>: left out: refused: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | a counted reading is inside that account's reserve and this run would launch the seat; this seat is not started, and the others still are. `accounts with room: none` when no other account has room |
| `<seat>: left out: refused: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | the money its check counted is at or below the account's floor, and this run would launch the seat; this seat is not started, and the others still are |
| `<seat>: left out: refused: its launch line starts `<word>`, which is not on the PATH` / `…, which does not exist` / `…, which is not executable` / `…, not found from `~`` / `…, not found from its start folder` | the program the line starts is missing where the seat starts — the lobby for a seat that works in worktrees. When the check looked in a folder it resolved, the record's reason stops at `…, not found from its start folder` and the sentence naming the folder is written under the record, on stderr. A first word that is one fully quoted literal (`"claude"`, `'zcash'`) is checked with the quotes removed, the way a shell would run it, and `<word>` is the word as written, quotes and all — a quoted `"~/x"` is a pathname with a literal `~` folder, resolved from the start folder, never the home. A path written as the program is read as main's launcher check read it: it must be there and executable, not merely there. This seat is not started, and the others still are |
| `<seat>: left out: refused: its launch line runs `<path>`, not found from its start folder` | the line runs a shell — `sh`, `bash` or `zsh`, by name or by path — whose first argument is a relative script path, not an option, and that script resolves from the project root but not from the folder the line will run in: the shell exits 127 without starting anything. The record's reason stops at `…, not found from its start folder`; the sentence naming the folder it looked in and the absolute path to write is written under the record, on stderr. This seat is not started, and the others still are |
| `<seat>: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | the same reading, and the seat is already running; setup continues and the line is only a notice — on a real run it is written to stderr, under the seat's record |
| `<seat>: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | the same money reading, and the seat is already running; setup continues and the line is only a notice — on a real run it is written to stderr, under the seat's record |
| `<seat>: <account> is unknown` | the account is in the file and its figure is unknown — a subscription with no counted reading, or a spend account whose money reading is missing, older than `budgets.stale_after`, or in another currency than the floor's. A subscription figure with no known reset is unknown while it could still matter — inside its reserve, or within the reserve again outside it; further out — more than the reserve again — it counts, the room the figure last held, and the launch decision is clear: no unknown line. The seat still starts, and the line is a notice written to stderr, under the seat's record, on a real run |
| `<seat>: <account>: first sight only, not yet counted` | the account's only readings are unconfirmed; the seat still starts, and the line is a notice written to stderr, under the seat's record, on a real run |

A `version: "0"` — exactly that literal, the placeholder a fresh `init` writes before the owner
fills the release number — is read as *no version declared*: the seat's first launch is not stopped
by it, and the model family is still compared, so a file whose model names a family the CLI does
not run stops as above. No other spelling is read that way: `version: "0.0"` stops the launch as
any mismatch would. [team doctor](doctor.md) says the placeholder as a note — what the seat really
runs, and the one edit that pins it.

`<account>` in these lines is the seat's own account: its `account:` when the file names one, its
`vendor` when it doesn't.

A launch line the check can't be sure of is never refused: it is printed as `  note <seat>: <why>`
and the seat starts. A note says the line was not checked — a word of it quotes or substitutes text
this version does not read, or its first word names no command — or that a relative path is not
there yet, `not checked: the command may create it`; that is every relative argument but the shell's
script path above — option text, an output path, a path the command creates, one a launcher changes
directory for — and a `~/…` that is not there now is said the same way. A seat resumed into an
existing pane is checked where that pane runs when the state records the folder it was started in;
without that record its launch line is not checked at all and the note says so — the file's folder
is not where that pane is. The notes are said once: on stderr on a real run, on stdout with the plan
on a dry one, as [team doctor](doctor.md) says them. A miss is not a note: on a dry run it leaves
the seat out as `  skip <seat>: would refuse: …`.

The plan a `--dry-run` prints is also what `team down --dry-run` prints: `+ <command>` for a command
that would run, a `    (<note>)` line under one that carries a note, `  wait <text>` for a wait,
`  skip <text>` for a seat left out, and `dry run: nothing was run` at the end. A seat a stored
reading would refuse, and that this run would launch, is `  skip <seat>: would refuse: …` and is not
in the commands — the same line a seat whose launch line can't run where it starts is left out with,
before its workspace is made. The words after `would refuse:` are the same as the words after
`refused:`. A seat
already running keeps its setup, with that reading in a note. A seat whose account is unknown
carries `(<account> is unknown; would launch)` under its first command. A first sight carries
`(<account>: first sight only, not yet counted; would launch)`. A launch carries the seat's rules
when they travel as a launch option (claude-code), so its line is long; a first-message seat's
launch is the plain CLI command, and the plan shows the one line it types at the seat's idle
prompt, with the note that the rules go to a per-seat file in the project state folder first.

## Refusals

A real run stops before the first step, prints one `team up: <reason>` per reason and exits 1:

| Reason |
| --- |
| ``only the owner runs `up`, from a terminal outside herdr; this call is <caller>`` |
| ``the file was never approved on this machine: run `team approve` `` |
| ``approved before records were signed: run `team approve` once`` — the record was written by an earlier `team` |
| ``the record <case>: run `team approve` once`` — a signed record that does not verify |
| ``the file is not the approved one (<differences>): run `team approve` `` |
| a `MISS` finding from [team doctor](doctor.md) — herdr or a CLI not installed, or a CLI not logged in. A launch that names another model than the file, or that names none, is a warning, so `up` still starts the seat; a seat's own launch line is not this — it leaves that seat out alone, in the lines above. After the idle wait, a screen that shows a different model leaves that seat at launched, not named |
| `the load is 1.2 per core, above 1` / `free memory is 8%, below 25%` / `free disk is 3.0 GB, below 10.0 GB` / `free swap is 1.0 GB, below 2.0 GB` |
| `herdr doesn't answer` |
| ``session beacon is stopped; clear it with `herdr session delete beacon` `` |
| ``session beacon has 2 agents this file's state doesn't record: `up` never touches a running team`` |
| ``the file is legacy: migrate trust to absolute paths including the lobby ~/.config/team/lobby: ...`` — followed by the whole `trust:` block to paste: every entry the next `up` requires, one line saying which key of the file each entry comes from, and, for an entry a rule of `trust` refuses, one line naming the key that forces it |
| ``the lobby ~/.config/team/lobby: <check>`` — gate check failed (symbolic link, permissions, mode, not empty, inside git repo) |
| ``seat beacon-qa would start in live, inside the protected checkout live; a seat that isn't `mode: shared` never starts in one`` — the folder the file gives it, or its lobby, is a protected checkout |

A watch that has not run, or whose heartbeat is old, is not a reason to refuse: `up` starts the
watch itself.

## Exit codes

- `0` — every seat is ready and the watch is running; or `--dry-run` printed its plan.
- `1` — the run was refused, or a seat was left out, or the server or the watch failed.
- `2` — the invocation or the team file can't be read.

## Examples

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

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: claude-qa
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
```

```fixture
agents: [claude-keeper, claude-beacon]
watch: none
state:
  seats:
    claude-keeper: {stage: ready}
    claude-beacon: {stage: ready}
```

Two seats are up and the third is stopped in the file, so the plan is short — the skipped seats, and
the watchdog pane this session has never had:

```console
$ team up --dry-run ; echo "exit $?"
  skip claude-keeper: already ready; left as it is; a relaunch records its process: team down, then team up (to restart the whole team)
  skip claude-beacon: already ready; left as it is; a relaunch records its process: team remove claude-beacon --keep, then team add claude-beacon (or team down, then team up, for the whole team)
  skip claude-qa: stopped in the file; start it with `team add claude-qa`
+ herdr --session beacon workspace create --cwd . --label watchdog --no-focus
+ herdr --session beacon pane run <pane of watchdog> 'team watch --session beacon'
    (a desktop notification follows when the watch exits)
dry run: nothing was run
exit 0
```

The same command for real runs exactly that:

```console
$ team up ; echo "exit $?"
claude-keeper: ready
  already ready; left as it is; a relaunch records its process: team down, then team up (to restart the whole team)
claude-beacon: ready
  already ready; left as it is; a relaunch records its process: team remove claude-beacon --keep, then team add claude-beacon (or team down, then team up, for the whole team)
  skip claude-qa: stopped in the file; start it with `team add claude-qa`
watch: started
exit 0
```

A seat is not the owner, so it can read a plan but not start a team:

```console caller=claude-beacon
$ team up ; echo "exit $?"
team up: only the owner runs `up`, from a terminal outside herdr; this call is claude-beacon
exit 1
```

A session stopped in herdr is never started over — `up` deletes nothing, and its refusal says the
command to run by hand. A session `team down` stopped never gets here: `down` clears the one it
stopped in the same run, so the next `up` finds no session and starts it from the beginning:

```console herdr=stopped
$ team up ; echo "exit $?"
team up: session beacon is stopped; clear it with `herdr session delete beacon`
exit 1
```

An owner section changed in the file needs a new approval, and the plan says so before the run:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

limits:
  seats: 4

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

  - role: reviewer
    name: claude-qa
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
```

```console
$ team up --dry-run ; echo "exit $?"
! up would refuse: the file is not the approved one (`limits` changed): run `team approve`
! up would refuse: run `team approve`: `limits` changed
  skip claude-keeper: already ready; left as it is; a relaunch records its process: team down, then team up (to restart the whole team)
  skip claude-beacon: already ready; left as it is; a relaunch records its process: team remove claude-beacon --keep, then team add claude-beacon (or team down, then team up, for the whole team)
  skip claude-qa: stopped in the file; start it with `team add claude-qa`
dry run: nothing was run
exit 0
```

The real run goes no further than the refusal — it never touches a team the file doesn't match:

```console
$ team up ; echo "exit $?"
team up: the file is not the approved one (`limits` changed): run `team approve`
team up: run `team approve`: `limits` changed
exit 1
```
