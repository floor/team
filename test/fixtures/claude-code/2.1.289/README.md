# Claude Code 2.1.289 terminal captures

Captured on 2026-10-04 with herdr 0.7.1, `pane read --source visible --format ansi
--lines 8`, from a Claude Code session on a GLM endpoint (no Anthropic quota) in the
scratch sessions `glm-scratch-placeholder` and `glm-scratch-style2`. The panes were the
captures' own; no other seat was read or typed into. Both sessions were stopped and
deleted afterwards, and the default session was not touched.

The captures hold what `paneRead` returns: ANSI-styled text with CRLF folded to LF.
Personal text is swapped for neutral words — the home path, the worktree name, the
model name, the account line, the usage figure — and nothing else is changed; every
SGR byte is the capture's own. The greyed suggestion is `ESC[0m ESC[2m` … `ESC[0m`
(faint), and typed text carries no styling at all. The gap after the `❯` is U+00A0, as
the CLI renders it.

- `idle-suggestion-ansi.txt`, `idle-suggestion-plain.txt`: an idle box greying
  `Try "fix typecheck errors"`, in the styled and the plain read. The suggestion is
  the session-start one; after turns the box renders empty.
- `unsent-typed-ansi.txt`: the same pane after typing `Fix the` (no Enter).
- `trust-ansi.txt`: the workspace-trust dialog of an untrusted worktree, styled. The
  workspace was closed without answering it; nothing on the owner's account changed.
  2.1.289 draws this dialog's choices without numbers, so the profile's trust stage —
  which wants `1. Yes` — does not match and the dialog reads `question`, on the plain
  capture as on this one. A question is attention either way; the safety floor holds.

## Constructed

Built from the captures above by replacing text, never bytes of styling:

- `idle-suggestion-other-ansi.txt`, `idle-suggestion-other-plain.txt`: the idle capture
  with the faint run's text swapped for `Resume briefly.`, a suggestion the placeholder
  list does not name. The styled one is idle by `placeholder_style: dim`; the plain one
  stays `unsent`, the documented limit of the plain fallback.
- `unsent-faint-first-ansi.txt`: the typed capture with the typed word opened in the
  suggestion's own faint bytes and closed after one character. Text with any normally
  styled character stays `unsent`.

No `Resume briefly.` suggestion could be produced in a scratch session — the sessions
showed their start-up suggestion and, after turns, an empty box — so the non-`Try`
fixtures are the constructed ones above.
