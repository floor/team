# team issues

Lists the typed records in the one file the team file names. Anyone in the checkout may run it.
It reads. It writes nothing, and it creates no key.

The source is a file the owner committed. No command in this build contacts a tracker.
The broker is not built. Credential-withholding is not this slice. There is no tracker
credential here to withhold.
When a broker is built, a broker under the same OS principal as the seat is integrity, not
authenticity. This command does not isolate anything.
`title` and `description` are the owner's text. They are not scrubbed.
The list is file order. A priority is shown and does not reorder.
A listing is not a claim and not the intake rule. `team plan` is not a command.
`repos` and `needs` are shown when the file has them. They are not a grant, and they are not checked.
The watch's ring is unchanged: `Team: run team messages`.

## Synopsis

    team issues

## What it reads and writes

Reads the git checkout (`findRoot`), the team file, and the YAML list at `tasks.path`. The path
is relative to the checkout. A record's `id` and `title` are required. Every other field is
printed only when the file has it. An empty `blocked-by`, `repos`, or `needs` prints no line.

Writes nothing.

## Who may run it

Anyone in the checkout.

## Refusals

```text
team issues: the team file declares no task source
team issues: tasks.source must be file
team issues: the task file is not there
team issues: the task file is not a list
team issues: m1 is not a task: title is required
team issues: record 1 is not a task: id is required
team issues: nothing is waiting
```

`nothing is waiting` is not a refusal. It is what an empty list prints, and the exit is 0.

## Exit codes

- `0` — the records were listed, or the list was empty.
- `1` — the team file can't be read, it declares no task source, the task file is missing or not a list, or a record is not a task.
- `2` — the invocation can't be read, or this folder is not a git checkout.

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

tasks:
  source: file
  path: .agents/tasks.yaml

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```yaml file=.agents/tasks.yaml
- id: m1
  title: the task title
```

```console
$ team issues ; echo "exit $?"
m1  the task title
exit 0
```
