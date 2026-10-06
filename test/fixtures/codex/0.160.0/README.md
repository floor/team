# Codex 0.160.0 terminal captures

Captured from the installed macOS Codex CLI (`codex-cli 0.160.0`) on 2026-10-05 with
herdr 0.7.1, `pane read --source visible --lines 200` (plain), in a scratch session of
my own with one Codex pane, 54 by 23 — the size `up` creates. The CLI was launched the
way a seat is launched, plus a pinned model so the status row is one the shipped profile
reads:

`codex -a never -s danger-full-access --no-daemon --no-alt-screen -m gpt-5.6-terra -c check_for_update_on_startup=false`

Texts were typed into the CLI's own box with `pane send-text` — the same call delivery
makes — and never sent, except `rules-part-16-after-reply.txt`, which is one sent turn
with a message of its own. Each box was cleared afterwards with its own key, Ctrl+C, and
the box was verified empty before the next text was typed. The session was stopped and
deleted. The standing-rules texts are what `rulesText` renders for a sample team file
(no real seat names); the fitted texts are numbered rows of a sample line.

`pane read --source visible` returns the pane's screen with leading and trailing blank
rows trimmed: the box rows are always followed by the status row and no more, and a read
can carry fewer rows than the pane is tall (`rules-fit-5.txt` carries 12 of 23). Every
reading below was taken from the returned text, as delivery reads it.

- `idle.txt`: the empty box, read `idle`. The banner's workspace path is replaced by
  `<workspace>`; the line is not part of any box, so the shorter stand-in moves nothing.
- `rules-fit-5.txt` / `rules-fit-12.txt`: five (twelve) drawn rows of the fitted text,
  after a sent turn, read `unsent` with every row of the text in the box. The transcript
  above the box — the echo of the sent message and its `Worked for 3s` line — does not
  stop the read-back.
- `rules-fit-16.txt`: sixteen drawn rows, the most the pane's last 20 lines can show:
  the input row, its fifteen continuations, the blank row above the input row the core
  requires, the frame blank and the status row all fit in the window. Read `unsent`, and
  the box's rows read back as exactly the typed text.
- `rules-fit-17.txt`: seventeen drawn rows. The window now starts at the input row
  itself, the core reads `unknown`, and no row of the box can be verified — so a
  seventeen-row paste gets no Enter however well it looks.
- `rules-fit-19.txt`: nineteen drawn rows, the most the pane itself draws before
  scrolling: all nineteen rows are on screen, and the screen still reads `unknown`
  because the window drops the input row. Nineteen is the pane's limit, not delivery's.
- `rules-fit-20.txt`: twenty drawn rows; the pane scrolls, drawing the last nineteen and
  dropping the first typed row entirely.
- `rules-short.txt` / `rules-medium.txt` / `rules-scrolled.txt`: the standing-rules
  message with no file rules (10 lines, 875 characters, 21 drawn rows at the width the
  pane draws), with four (14 lines, 1044 characters, 26 rows), and the real seven
  (17 lines, 1193 characters, 30 rows). Each is taller than the window can show, so each
  reads `unknown`: on this CLI the message is never delivered in one paste.
- `rules-part-16-after-reply.txt`: sixteen drawn rows typed after a sent turn that was
  answered. The transcript above it holds the echo of the sent message and the reply;
  the box still reads `unsent` and its rows read back as exactly the typed text, which
  is what a second part of a split delivery sees.
- `rules-line.txt`: the one line delivery types instead of the whole message, captured
  2026-10-05 in a fresh scratch session (stopped and deleted) with the same launch
  line, pane size and read. The line, a neutral store path of the same shape,
  166 characters: `Read /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md
  (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for
  your brief.` The pane draws it in four rows; a break after a `/` hides nothing and a
  break at a space hides that one space. Read `unsent`. Typed with `pane send-text`,
  never sent, cleared with Ctrl+C, the box verified empty. The whole-message captures
  above stay as documentation of why a whole paste cannot be proved on this CLI: past
  this line, the rules arrive in a file the line points at.
- `rules-scrolled-narrow.txt`: the same seven-rule message in a 27-column pane — a split
  pane whose tty was set to 27 columns before the CLI started (`stty cols 27 rows 23`,
  then the launch; the session's panes otherwise keep a 54-column tty whatever `pane
  layout` reports for a split). At 27 columns the message wraps to more rows than the
  pane holds: the pane's own top row is the box's prompt row, everything before it
  scrolled out of the pane, and the screen reads `unknown` with no box to read back.
  The narrower width changes nothing about the shape: still no marker, still a scroll.

## The exit read-back

Captured on 2026-10-06 with herdr 0.7.1, `pane read --source visible`, from the
same installed Codex 0.160.0, one pane in a scratch session that was stopped and
deleted afterwards. `/exit` was typed with `pane send-text` and not sent. The
update banner was on screen; Codex was not upgraded.

- `exit-idle.txt`: the placeholder `Ask Codex to do anything` the instant `/exit`
  had been typed. The box does not hold the text yet. Read `idle`.
- `exit-menu.txt`: the same pane a moment later. The slash menu is open and the
  box holds exactly `/exit`. Read `unsent`.

