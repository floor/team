# team answer

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has to pass on two fresh reads of the pane. Anything else sends nothing.

## Synopsis

    team answer <seat> trust [--session <name>] [--file <path>] [--json]

`<seat>` names one configured live seat. `trust` is the only dialog word. No option takes a key, a text, or another dialog.

## What it reads and writes

Reads the team file, this machine's approval, the seat's state, the installed CLI's version, and the pane. On success it sends one key, then writes the seat through `trust-sent-recovery` to `ready` and delivers the ordinary rules. A refusal before the key writes nothing. A failure after the key leaves `trust-sent-recovery`.

## Who may run it

The owner, from outside herdr, or the coordinator from its own seat. With `dialogs.trust: owner` (the value when `dialogs` is omitted) nobody sends a key, the owner included.

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--json` | print one JSON object and nothing on stderr |
| `--help`, `-h` | the usage, and exit 0 |

## Examples

```console
$ team answer
team answer: a seat and trust are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
```
