# team send

Writes one message to one seat over the cross-session message socket — the channel a Claude Code
session exposes at the runtime temp folder's `cc-socks/<pid>.sock` — and never types into the
seat's pane. One send is one JSON line on that socket, and nothing comes back on the connection:
`delivered` means the socket took the frame, not that the seat's agent read it. The receiving
session's own inbound policy decides when the frame surfaces, and a session started without
`crossSessionInbound: accept` holds a frame from an unidentified sender until its owner lets it
through.

The socket is a measured observation of Claude Code 2.1.295, not a stable API: JSON lines, one
frame per line, a first-line deadline of 30,000 ms, and a buffer limit of 1,048,576 characters.
A frame over that limit is refused, never truncated. Nothing of a message is written down: the
log keeps the seat and the frame's size.

The outcome is always confirmed — one of `delivered`, `unreachable` or `refused`, printed and
matched by the exit code. This build carries the socket channel only: a seat of a native CLI
(codex, cursor, grok, antigravity) is refused with the reason, because the daemon that delivers
to a native CLI, `--wait` and its timeout, `--json`, `--list` and broadcast are later
increments.

## Synopsis

    team send <seat> <message>
    team send <seat> --file <path>

`<seat>` names one seat of the team file — the same resolution `team status` uses. The message
is every remaining word, joined with single spaces; `--file` reads the whole body from a file
instead (and then takes no message words). A seat that has both a message and `--file` is a
usage error.

## What it reads and writes

Reads the team file, the caller's placement, the herdr session's agents, the processes of the
seat's pane, and the socket file's presence in `cc-socks`. The socket is the first of the pane's
processes — the foreground processes first, then the shell — with a file at
`<sockets dir>/<pid>.sock`. The command holds the seat's lock
(`<state dir>/seat-locks/<session>/<seat>`) around the write, so a launch of the same seat
cannot act beside it. It writes one line to `.agents/team.log`.

## Who may run it

The owner, or the orchestrator from its own seat, on the pane the project's state records for
it — the same check `team answer` makes, judged the same way. Every other caller is refused
before the seat is looked up.

## Outcomes

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout |
| unreachable | 1 | `team send: <seat>: unreachable: <reason>` on stderr |
| refused | 1 | `team send: refused: <reason>` on stderr |
| usage | 2 | `team send: <message>` and the usage on stderr |
| configuration | 2 | `team send: <message>` on stderr |

`unreachable` is the seat's channel not being open: no live agent of that name, no socket file
for the pane's processes, or a connection that would not take the frame. `refused` is nothing
being sent on purpose: an unknown seat (the file's seats are named), a native-CLI seat, a frame
over the limit, a lock another command holds, or a caller that may not send.

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

  - role: reviewer
    name: gpt-reviewer
    label: reviewer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
```

A message to a Claude Code seat goes out on its socket:

```console
$ team send claude-keeper "the gate is green" ; echo "exit $?"
claude-keeper: delivered
exit 0
```

A name the file does not carry is refused, and the file's seats are named:

```console
$ team send nobody "hello" ; echo "exit $?"
team send: refused: nobody: it is not a declared seat; the file's seats are claude-keeper, gpt-reviewer
exit 1
```

A native-CLI seat is refused: this build does not carry that channel yet, and nothing is sent.

```console
$ team send gpt-reviewer "hello" ; echo "exit $?"
team send: refused: gpt-reviewer runs codex: this build carries the cross-session socket channel only, and the delivery daemon for a native CLI is not built yet; nothing was sent
exit 1
```
