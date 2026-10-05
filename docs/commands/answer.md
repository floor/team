# team answer

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has to pass on two fresh reads of the pane. Anything else sends nothing.

## Synopsis

    team answer <seat> trust [--session <name>] [--file <path>] [--json]

`<seat>` names one configured live seat. `trust` is the only dialog word. No option takes a key, a text, or another dialog.

## What it reads and writes

Reads the team file, this machine's approval and the approved copy the trust entries are read from, the seat's state, the installed CLI's version, and the pane. The version must match a record whose own capture is registered (`src/profiles/trust-answer.ts`); Codex's record also needs a registered capture of its folder layout in the real lobby and none exists, so Codex answers nothing today. The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) for its whole run, so a launch of the same seat cannot act beside it.

On success it writes `trust-sent-recovery` into the seat's state and reads it back **before** sending the key: a crash between the two leaves a recovery a retry only observes, never a dialog answered twice. It then sends one key, waits for the idle prompt, delivers the ordinary rules, and writes the seat `ready`. A refusal before the key writes nothing; a failure after it leaves `trust-sent-recovery`.

## Who may run it

The owner, from outside herdr, or the coordinator from its own seat. With `dialogs.trust: owner` (the value when `dialogs` is omitted) nobody sends a key, the owner included.

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml` |
| `--json` | print one JSON object and nothing on stderr |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

Human output is one line: refusals and recovery on stderr, success on stdout. Under `--json`, the same outcomes print one object on stdout and stderr stays empty.

| Outcome | Exit | stdout | stderr |
| --- | --- | --- | --- |
| answered | 0 | `<seat>: trust answered; ready` | — |
| refused | 1 | — | `<seat>: <reason>` |
| recovery | 1 | — | `<seat>: trust sent; recovery required` or `<seat>: the key could not be sent; recovery required` |
| usage | 2 | — | `team answer: <message>` and the synopsis line |
| configuration | 2 | — | `team answer: <message>` |

The JSON objects, by `status`:

| status | Object |
| --- | --- |
| `answered` | `{"seat":"<seat>","dialog":"trust","status":"answered","state":"ready"}` |
| `refused` | `{"seat":"<seat>","dialog":"trust","status":"refused","reason":"<reason>"}` |
| `recovery` | `{"seat":"<seat>","dialog":"trust","status":"recovery","state":"trust-sent-recovery","reason":"<reason>"}` |
| error | `{"error":{"code":"usage"\|"configuration","message":"<message>"}}` |

The recovery reasons are `its key could not be sent`, `its idle prompt did not come`, and `its rules were not delivered`. The usage message is `a seat and trust are required`, `unknown dialog "<word>"`, or the argument parser's own message. The configuration message is the file's problem list (`line <n>: <problem>`, joined with `; `) or `the team file cannot be read`.

### Refusals

Every refusal line is `<seat>: <reason>` except an unplaced caller's, which is its reason alone and names no seat. The classes are the log line's own (`refused trust: <class>`):

| Class | Reasons |
| --- | --- |
| caller | `only the owner, or the coordinator from its own seat, can answer`; the unplaced caller's reason; `the file was never approved on this machine: run \`team approve\``; `approved before records were signed: run \`team approve\` once`; the approval verification's own reason; `the file is not the approved one (<section> changed; …)` |
| policy | `use team up and [o]` |
| state | `another command holds it`; `it is not a live seat`; `the owner has the pane open`; `it is not waiting at a trust dialog`; `its recovery state could not be recorded` |
| version | `this version has no trust answer` |
| screen | `the pane is not the trust dialog` |
| label | `the trust choice is not the recorded one` |
| folder | `the dialog does not show exactly one folder`; `the dialog does not show the lobby as written`; `this folder is not an exact trust entry`; `ask the owner to approve this exact folder and answer through team up` |
| action | `the recorded key is not one this version sends` |

`action` is a well-formedness defence: it is reached only when a profile records a key byte the host does not send, which the shipped profiles (0d, 31, 61) do not.

## Exit codes

| Code | Id | Meaning |
| --- | --- | --- |
| 0 | `answer.ready` | the trust dialog was answered and the seat is ready |
| 1 | `answer.action` | the recorded key is not one this version sends |
| 1 | `answer.caller` | the caller may not answer a trust dialog |
| 1 | `answer.folder` | the dialog's folder is not the lobby's exact trust entry |
| 1 | `answer.label` | the trust choice is not the recorded one |
| 1 | `answer.policy` | the file leaves trust dialogs to the owner |
| 1 | `answer.recovery` | the trust answer did not complete: the seat stays in recovery, and the key may or may not have been sent |
| 1 | `answer.screen` | the pane is not the trust dialog |
| 1 | `answer.state` | the seat is not waiting at a trust dialog |
| 1 | `answer.version` | this version has no trust answer |
| 2 | `answer.configuration` | the team file cannot be read |
| 2 | `answer.usage` | the invocation is not a seat and trust |

## Log lines

Every run writes one line to `team.log`: `<ISO timestamp> answer [<who>] <seat>: <message>`. `<who>` is the class the caller check returned — `owner`, `coordinator`, `seat`, or `unplaced` — never the owner for a caller that is not the owner. No line holds pane text, a pane id, a folder, or an unplaced reason.

| Message | When |
| --- | --- |
| `refused trust: caller` | the caller check refused |
| `refused trust: policy` | the file leaves trust dialogs to the owner |
| `refused trust: state` | the lock, seat, waiting state, or recovery write refused |
| `refused trust: version` | no record matches the printed version, or it changed between reads |
| `refused trust: screen` | the pane is not the trust dialog |
| `refused trust: label` | the recorded label is not marked on screen |
| `refused trust: folder` | the folder is not the lobby as written, or not an exact trust entry |
| `refused trust: action` | the recorded key is not one this version sends, or the send failed |
| `refused trust: idle` | the key was sent; the idle prompt did not come |
| `refused trust: rule delivery` | the key was sent; the rules were not delivered |
| `trust answered` | the seat is ready |

## Examples

```console
$ team answer
team answer: a seat and trust are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
```
