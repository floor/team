# The team file

`team` reads one team file per clone: `.agents/team.yaml` under the project root, or the path
`--file` names. It is a documented subset of YAML, read by the library's own parser — maps, lists,
one-line `{ }` and `[ ]`, plain and quoted values, comments; anchors, aliases, merge keys, tags,
block scalars, a second document and duplicate keys are refused, with the line number. The JSON
Schema ships at `schema/team.schema.json`, and `team init` writes a
`# yaml-language-server: $schema=…` line so editors validate the file. README's
[The file's format](../README.md#the-files-format) walks the whole format by example; this page
documents the sections one by one.

## `delegates`

Names panes outside the team's session that may run some operational commands as a delegate of
this team file. It is an owner section: adding, changing or removing it is a change to the file
the owner approves. Omitted, it reads as `null` and nothing is delegated.

```yaml
delegates:
  - pane: main/w1:p1        # <herdr session>/<pane id>, outside the team's session
    commands: [up, down]    # of up, down, add, remove, approve: non-empty, distinct, order kept
  - pane: main/w2:p1
    commands: [add, remove]
```

- One to eight entries, each a map with exactly `pane` and `commands`; two entries naming one
  pane are refused.
- A pane is herdr's pane ID — `<session>/<pane id>`, such as `main/w1:p1` — one slash, no
  whitespace, matched on the whole string and case-sensitively. A pane closed and made again has
  a new ID, so delegation is off until the owner approves a file naming that new ID.
- `commands` names at most one each of the five `up`, `down`, `add`, `remove` and `approve`.
  Entry order and command order are part of the value the owner approves: a reorder is a change
  like any other.
- `approve` is granted like the rest, under the gate's guard, and the guard is an allowlist:
  a delegated approval admits the roster and `rules`, and refuses, fail-closed, every other
  owner section — `delegates`, `budgets`, `limits`, identity, `trust`, the workspace, the
  operator and orchestrator — and any section added later, so a delegate can never approve a
  change to its own authority. A delegated approval of an ordinary change — the roster, a
  launch line, a rule — passes, and the write records one audit line naming the pane and what
  it sealed.
- A pane named in several approved team files is a delegate of each — the files do not see or
  limit one another — and in every one of them the owner-only sections stay the owner's, never
  a delegate's.
- A pane's own shell reaches that pane's grant when the pane's root process is among the
  caller's ancestors. `HERDR_PANE_ID` only names which pane to read; the pid is what places
  the caller. No such variable, a root that is not an ancestor, or a pane-root read that
  fails places nobody, as before. A command the grant does not list is still refused, and a
  pane no grant lists is refused by name: `it runs in pane <session>/<pane id>, which no grant lists`.
- Delegate placement is an accident guard, not a security boundary. The pane ancestry and
  herdr's pid vouch are forgeable by a hostile process of the same user, which this tool does
  not resist: it guards a mistaken agent, not a hostile one. Nothing in the grants or in
  `trust:` is changed by that.
