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

## Round 2: the unsafe direction

Captured the same day, the same way, in the scratch session `glm-scratch-r2`. A paste
chip needed the bytes a terminal sends a paste — `ESC[200~`, the lines, `ESC[201~` —
delivered with `pane send-text`; herdr has no paste command of its own, and unwrapped
newlines only open continuation lines. Everything personal is swapped as above, plus
the cost figure; the model name in the status rows reads `Opus 5.5`.

- `unsent-slash-ansi.txt`: `/effort` typed, the slash menu open above the box. The
  command text carries a truecolour style (`38;2;177;185;249`): a colour, so unsent.
- `unsent-paste-ansi.txt`: `[Pasted text #2 +7 lines]` in the box after the wrapped
  paste. The chip renders with no styling at all — real content, unsent by the list.
- `unsent-typing-while-running-ansi.txt`: `hurry please` typed while a turn runs. The
  spinner line works; the prompt itself is styled `38;2;153;153;153` — grey, and only
  faint is a placeholder — with the typed text plain after the reset.
- `bash-mode-ansi.txt`: `!` bash mode, `ls -la /tmp` typed. The `!` replaces the
  prompt glyph (styled `38;2;253;93;177`), so the composer finds no input line and
  the screen reads unknown — never idle. Whether `!` belongs in the prompt set is an
  open question for the profile, not this change.

Every captured composer draws its rows directly between the two rules — `unsent-typed-ansi.txt`
is the typed box as the pane drew it — with no empty row of its own inside the box. The
profile counts no frame rows (`frame_rows` omitted, zero): the box read keeps every
trailing empty row, and a box showing one the typed text does not have is refused.
