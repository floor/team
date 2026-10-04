# Codex 0.157.0 terminal captures

Captured from the installed macOS Codex CLI on 2026-10-03 with herdr 0.7.1,
`pane read --source visible --lines 80`, in the scratch session `team-test-codex`.
There was at most one Codex seat at a time. The session was stopped and deleted;
the default session had eight agents before and after. Config and auth hashes were unchanged.

- `startup.txt`: `codex -a never -s danger-full-access --no-daemon --no-alt-screen`
  reached an update notice. Its workspace was closed without input.
- `trust.txt`: the same command with the invocation-only
  `-c check_for_update_on_startup=false`, in an untrusted worktree. The workspace
  was closed without answering the trust question.
- `idle.txt`, `unsent.txt`, `working.txt`, `rules-accepted.txt`: the second command
  in an already-trusted folder. The rules message was pasted, read back, and submitted.
  `working.txt` coincided with herdr reporting `working`; the composer was empty.
  The only model response was `RULES_RECEIVED`. It was instructed to use no tools or files.
- `exit-typed.txt`, `exit.txt`: `/exit` pasted at idle, read back, then submitted.
  Herdr subsequently listed zero agents and the foreground process was `zsh`.

Paths and the session UUID are replaced with placeholders. Shell launch scrollback before
Codex's header is removed from idle and unsent captures. All other visible text is retained,
including wrapping and the configured model footer. The model was the owner's CLI default;
the profile does not select a model. These fixtures do not assert a vendor permission or
question layout that was not observed. Unknown screens permit no input.

The update-check override was for capture only, not added by the profile. It is documented in
[OpenAI's configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
No update, login, trust, or settings dialog was answered, and no vendor configuration was edited.

## Round 2

The profile now adds `--no-daemon --no-alt-screen`, matching these captures. Inline
mode preserves the readable pane composer and scrollback; a dedicated process avoids
depending on a shared daemon. This is the smaller fix: keep the observed launch mode
and fixtures instead of claiming they cover a different mode.

The repeat scratch run used `launchCommand(codex, 'codex -c check_for_update_on_startup=false', rules)`
directly: only the update-check override was supplied by the seat launch, as above.
The profile supplied every other flag. One seat verified idle, pasted rules, working,
acknowledgement and `/exit`, then its workspace and scratch session were removed.

The repeat run also captured `startup-loading.txt`: Codex draws a composer while the
model is still loading. That screen stays unknown until initialization finishes.
The final run waited for the startup prompt to settle before delivery; two earlier
attempts refused delivery during startup and were torn down without submitting a
message. The default session remained at eight agents, with unchanged config/auth hashes.

## Constructed

`owner-status.txt` is constructed, not a capture. Nothing in it was read from a live pane.
It is `idle.txt` with the status row replaced by an owner's configured status line: session
and weekly use, and the time until each resets. The row is one the shipped composer already
recognizes. Without an override pattern the line reads no figure.

## Permission dialog

`permission.txt` was captured on 2026-10-04 in `team-test-codex-perm`, with one
seat in a throwaway folder under an already-trusted project. The command was
`codex -a on-request -s danger-full-access --no-daemon --no-alt-screen -c check_for_update_on_startup=false`
with an initial prompt requesting approval for `ls`. No input followed launch;
the permission dialog was read, then the workspace closed without answering it.

Full-access sandboxing allowed the first attempt's `ls` without a dialog. The
successful capture used a temporary project-local `.codex/config.toml` and
`.codex/rules/capture.rules` with `prefix_rule` entries for `ls` and `/bin/ls`,
`decision="prompt"`, and justification `Permission dialog capture`, as described
in [OpenAI's rules documentation](https://learn.chatgpt.com/docs/agent-configuration/rules).
Those files and the throwaway folder were removed. These are capture-only settings;
the launch profile is unchanged. Visible text is retained, including the quota notice.

Both attempts were torn down. The scratch session was stopped and deleted, with
zero agents after workspace closure; the default session had 14 agents before and
after. No owner configuration was written by the harness. The auth hash stayed
unchanged; the config hash changed during the capture window, so this run does
not assert that the owner's configuration remained unchanged.

## Constructed: `permission-pinned.txt`

Not a capture. It is the captured dialog with the captured status line below it,
built from the files here with
`{ cat permission.txt; echo; tail -n 1 idle.txt; } > permission-pinned.txt`:
the dialog's own footer, a blank line, then `idle.txt`'s last line, the model
footer Codex keeps pinned at the pane's bottom. It stands for a permission dialog
drawn while that pinned status line stays below it — a screen the classifier read
as `unsent`, so `deliverRules` reported the rules delivered and the watch typed a
nudge and Enter onto the dialog. Nothing else is added or changed. Its tests are
in `test/launch/codex.test.ts` and `test/screen-core.test.ts`.

## Constructed: delivery-verification boxes

Not captures. `test/launch/codex.test.ts` builds the post-paste box from `idle.txt`:
the placeholder row is replaced by `› ` and the first line of the typed text, and each
later line is drawn at two columns, the prompt row's own width, matching the continuation
indent `unsent.txt` shows. A box built this way stands for the typed text as Codex draws
it, and the same tests paste into the captured `unsent.txt`, whose four rows read back as
the message the capture submitted. No captured box shows a wrapped line, so no wrap is
modelled for Codex: a box whose rows read back as runs of the typed text laid out in
order is the text and is entered, and a box whose rows show anything else — another
text, an extra row, one character changed, a collapsed space, a blank row the text does
not have at that place — is never entered. The pane draws one empty row of its own under
the text — `unsent.txt` and `exit-typed.txt` show the drop between the text and the status
line — and that row is the box's frame, not content: the profile counts it
(`frame_rows: 1`), the box read strips just it, and an empty row beyond it is a row the
text does not have, so the Enter is refused.
