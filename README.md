# team

Set up, change and watch a project's team of AI agents from one file.

`team` is a small command-line tool with no runtime dependencies. A project declares its team in
`.agents/team.yaml`: the seats, the model each one runs, how each agent signs its work, the rules it
works under, the folders it may touch. Commands then check that file against a machine, a session
and a history, and build and watch the team itself. Version 0.1 runs teams in
[herdr](https://herdr.dev).

**Status: 0.1, early: herdr only; trust is specified, not built yet.** This build parses and
validates the file, checks who is calling, and holds `add`, `approve`, `check`, `doctor`, `down`,
`init`, `remove`, `status`, `up`, `watch` and `worktree`.

## Install

Node 22 or later runs the built command.

```sh
npm install -g team       # or run it without installing: npx team
team --version            # 0.1.0
```

## The file is private to each clone

`team init` keeps `.agents/team.yaml` out of git through `.git/info/exclude`, never by editing
`.gitignore`: a public repository shouldn't carry its roster. A fresh clone therefore has no team
file. Run `team init` to write one, or `team init --restore` to bring back the copy you last
approved on this machine. A file you receive from someone else runs nothing until you approve it
yourself.

## The file's format

A documented subset of YAML, read by the library's own parser: maps, lists, one-line `{ }` and
`[ ]`, plain and quoted values, comments. Anchors, aliases, tags, block scalars, several documents
in one file and duplicate keys are refused, with the line number. The file starts with `format: 1`.
By example:

```yaml
format: 1                     # the only format this version reads
project: hello
coordinator: claude-coord     # the seat that dispatches work
operator: claude-coord        # the seat the watch reports to

identity:
  signature:
    commits:
      position: trailer       # last-line | trailer | anywhere
      exempt: [merge]         # merge commits need no signature

rules:                        # lines added to every seat's rules at launch
  - Run the tests your change touches, not the whole suite.

workspace:
  mode: shared                # shared | worktree: the default for every seat

seats:
  - role: coordinator
    name: claude-coord
    cli: claude-code          # the launch profile
    vendor: anthropic         # the model's maker
    model: Claude Opus        # the model's name, without its version
    version: "5.5"            # the release alone, quoted
    launch: claude --model claude-opus-5-5   # no approval flags: the profile adds them

  - role: implementer
    name: codex-hello
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol        # the vendor's spelling, for the signature
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high
    parked: true              # running, and not reported while idle

  - role: implementer
    name: deepseek-hello
    cli: claude-code          # DeepSeek's model, run by Claude Code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek     # a launcher on the PATH, holding the account's key and endpoint
    count: 2                  # deepseek-hello and deepseek-hello-2

  - role: reviewer
    name: grok-hello
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok --model grok-4.7
    stopped: true             # kept in the file; `up` doesn't start it
```

- `session` names the herdr session and defaults to `project`; `--session` overrides it.
- `coordinator` and `operator` name seats: the coordinator dispatches work, the operator receives
  the watch's reports and nudges.
- `identity.signature` is the rule `check` enforces: a template, where it must stand, and which
  commits are exempt. Commit signatures read `Agent: {display} · {role}`, pull request bodies
  `**Agent:** {display} · {role}`. Without `display`, the signature reads "model version"; with it,
  the vendor's own spelling. `identity.since` skips an older history, `identity.humans` lists commit
  authors who don't sign, and `identity.forbidden` adds to the defaults — `^Claude-Session:` lines
  and session links are always refused.
- `seats[*].cli` picks the launch profile; `claude-code`, `codex`, `cursor` and `antigravity` are available, and `team
  doctor` says what the others still need. `vendor`, `model` and `version` spell one seat's model.
- `launch` is the plain command, without approval flags: the profile adds them. `count: 2` makes the
  numbered names; `parked` keeps a seat out of idle reports, `stopped` keeps it out of `up`.
- `workspace.mode` is `shared` (every seat in the project) or `worktree` (each task in its own
  checkout, with `path`, `base` and `setup`). Under `worktree`, a seat that isn't `mode: shared`
  starts in the lobby — the parent of `workspace.path` with `.lobby` beside the worktrees, inside
  `trust` and outside every protected checkout — never in the project root; `up` and `add` refuse a
  seat whose folder, lobby included, would be protected or untrusted.

The Codex profile is tested with CLI 0.157.0. It adds `-a never -s danger-full-access`
for unattended execution, plus `--no-daemon --no-alt-screen` for the captured pane mode,
and checks login with `codex login status`. Rules go as a first message
only at an empty idle prompt; delivery is recorded after Codex starts working with the input
empty again. Nothing writes a vendor config or an `AGENTS.md`. `/exit` is sent only to a free
seat. Update and workspace-trust screens are reported and closed without input; the owner
handles them before relaunching. Other unrecognised layouts stay unknown.

The Antigravity profile is tested with CLI 1.2.16 (`agy`). It adds `--dangerously-skip-permissions`
for unattended execution, and checks authentication with `agy models`. Rules go as a first message
only at an empty idle prompt; delivery is recorded after the CLI starts working with the composer
empty again. Nothing writes a vendor config or an `AGENTS.md`. `/exit` is sent only to a free
seat. Workspace-trust screens are reported and closed without input; the owner trusts the folder
before relaunching. Other unrecognised layouts stay unknown.

Launching a Cursor seat, like launching cursor-agent by hand, creates Cursor's own project record
under ~/.cursor/projects for that folder; team writes no trust (.workspace-trusted) and no Cursor
config.

More fields exist — `tools`, `trust`, `machine`, `limits`, `watch`, `visibility` — and the comments
`team init` writes name them; validation refuses what it cannot check, and this build acts on what
the commands below read.

## Commands

| Command | What it does | Who may run it |
| --- | --- | --- |
| `team init` | writes the skeleton `.agents/team.yaml` and adds it and its runtime files to `.git/info/exclude` | the owner |
| `team approve` | reads the whole file back for a last look, then records it, its ceilings and its seats on this machine; `--show` prints it | the owner (`--show`: anyone) |
| `team check <ref>` | checks one commit, a `a..b` range, or a PR body (`--pr <file>`, `-` reads stdin) against the signature rule; exit 1 when one is refused | anyone; read only |
| `team doctor` | checks this machine for what the file needs: herdr, each CLI, login, launcher, model, watch heartbeat; `--login` checks only CLI sign-ins | anyone; read only |
| `team status` | prints the file's seats against the running session, each difference with its repair; `--json` outputs a stable JSON document (`format: 1`) for scripts; exit 1 when they differ | anyone; read only |
| `team up` / `team down` | starts / stops the session and its seats | `up`: the owner; `down`: the owner, the coordinator or the operator seat |
| `team watch` | watches the session, reports idle seats and nudges the operator; `--no-nudge` and `--no-notify` turn those off | anyone, one per session; it types only its fixed nudge, into an empty idle prompt |
| `team add <name>` | starts one declared seat, or puts one back from the approved copy; `--temporary --like <seat> --until <end>` starts a seat the file does not hold | the owner, the coordinator or the operator |
| `team remove <name>` | stops one seat, then takes it out of the file; `--keep` leaves it stopped; `--abandon` is the owner's, and types nothing | the owner, the coordinator or the operator; only the owner removes the coordinator or the operator |
| `team worktree new <task>` / `team worktree remove <task>` | creates a task worktree from an up-to-date base, or removes its folder; a failed setup is kept and recorded; the branch is never deleted; ignored files in the worktree are deleted with it | the owner, the coordinator or the operator |

Each command has its own page in [docs/commands](docs/commands/): the synopsis, what it reads and
writes, who may run it, every flag, the refusals with their exact text, the exit codes, and examples
that `bun run ci` runs against a fixture team.

The owner is a terminal outside herdr with no agent process above it: a seat, or a script a seat
runs, cannot approve a file or start a team. Every command that reads the file also takes
`--file <path>` for a file other than `.agents/team.yaml`.

`team status --json` prints the facts `status` prints as one JSON document (`format: 1`) on stdout:
`project`, `session`, `rows` (`name`, `state`, `model`, `pane`), `notes`, `differences` (`what`, `repair`), and `notice`.

`team doctor --login` checks read-only that each CLI in the file is signed in, using each profile's
existing login check command (`cursor-agent status`, `agy models`, `codex login status`, `claude auth status`).
It never answers prompts and performs no sign-in action.

`team up`, `team down`, `team add`, `team remove`, `team worktree new` and `team worktree remove`
run live. `up` and `down` take `--dry-run` to print every command they would run, and every
refusal, and change nothing. `trust` is specified but not built yet.

## Your first team in five minutes

```sh
mkdir hello && cd hello && git init
team init                  # the owner: writes .agents/team.yaml, private to this clone
$EDITOR .agents/team.yaml  # name your seats — the example above is a working file
team approve               # the owner: read the file it prints, then type the seat count
team doctor                # what this machine still needs
team up --dry-run          # every command it would run, and every refusal
team up                    # the owner: starts the session and its seats
```

`team init` writes a skeleton, one seat and lots of comments; it prints how the file stays private,
and leaves your first commit as a commented `#   since:` line. `team approve` prints the whole file
back and asks you to type how many seats it holds, so no file approves itself unnoticed. Then
`doctor` says what is missing on this machine, `up --dry-run` shows every command the launch would
run — and `up` starts the team, from the owner's terminal outside herdr.

## Development

To run this tree's command from a clone instead of npm:

```sh
git clone https://github.com/floor/team.git
cd team
bun install
bun run build
npm install -g .          # puts `team` on the PATH
team --version            # 0.1.0
```

Bun builds and tests the sources:

```sh
bun install
bun run typecheck
bun test
bun run build        # dist/, which runs on Node 22 or later
bun run ci           # what CI runs: typecheck, tests, build, then the built command's --version
```

Sources import each other with `.ts` extensions and use erasable syntax only, so Node can run them
directly; `tsc` writes `dist/` for the published command. CI also runs `team check` on every pull
request, against the team file the repository keeps at `.github/team.yaml`.

### The end-to-end run

`bun run e2e` drives the real commands — `status`, `watch` (one pass), `add --temporary --like`,
`remove` and `down` — against fake seats, in a herdr session of its own (`team-test-e2e`) that it
creates and always stops and deletes. A fake seat is `scripts/fake-seat.ts`: a pane that draws one
of the screens the commands classify, logs every byte typed at it, and leaves on `/exit` and Enter.
No model runs and nothing reaches the network. After each command the run checks its exit code, its
own output, the log lines it wrote to `.agents/team.log`, and the seat records in
`.agents/team.state.json`.

It is local only: CI has no herdr, so `bun run ci` does not run it. It refuses to start when herdr
is not on the PATH, when the machine is over its gate (load under 60, 25 % memory free, swap not
growing over a minute), or when a session named `team-test-e2e` already exists. It works in a fresh
folder under the system's temporary directory — the project, the approval store and the fake seats'
input logs — and prints that path; it never writes the owner's home. It reads the default herdr
session's agent list before and after, and fails when the count changes.

Every check prints a line; the run ends with `all N checks passed` or `M of N checks failed` and
exits 2 when it refused to start, 1 when a check failed. A failed step skips the steps after it,
and the session is stopped and deleted on every path.

## Releasing

The owner cuts a release by pushing a version tag: `git tag v0.2.0 && git push origin v0.2.0`. The
Release workflow (`.github/workflows/release.yml`) refuses a tag that isn't `package.json`'s
version or whose commit isn't on `main`, runs `bun run ci`, then publishes with npm trusted
publishing — the workflow's own identity, no token stored — and provenance. A version with a
hyphen (`0.2.0-next.1`) goes under the `next` dist-tag, any other under `latest`. Once npm has the
version, the same run creates the GitHub release from the `CHANGELOG.md` section for it, marked a
pre-release when the version is one. If the GitHub release step fails — a missing changelog
section, say — use "Re-run failed jobs": a full re-run goes back through `npm publish`, which
fails because that version is already on npm. A tag ruleset protecting `v*`, so that only the
owner creates version tags, is recommended.

Trusted publishing must be bound once, by the package owner, on npmjs.com: the package `team` →
Publishing → trusted publishers → GitHub Actions, naming `floor/team` and the workflow file
`release.yml`; until then the workflow cannot publish. The 0.1.0 release itself is a manual
`npm publish` from a clean `main`; the workflow covers the releases after it.

## License

MIT
