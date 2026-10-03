import type { Screen } from '../watch/screen.ts';

/** Grey suggestions in an empty box. Typed text that matches one is still empty. */
const EMPTY_PROMPT = new Set(['Plan, search, build anything', 'Add a follow-up']);

/** Visible text captured from Cursor Agent 2026.10.01. Unknown layouts never permit input. */
export function cursorScreen(lines: string[]): Screen {
  const composer = cursorComposer(lines);
  // A trust dialog is read before the working line, as for claude-code: it can stay up while a
  // turn runs, and it is left unanswered, not input to type past.
  if (composer.kind === 'trust') return composer;
  // Herdr can lag a state transition. An active turn never permits a first message or an exit,
  // and is a working observation even while herdr's status has not caught up.
  if (lines.some((line) => /ctrl\+c to stop/.test(line) || /^\s*[\u2800-\u28FF]+\s+(Working|Thinking)\b/.test(line))) {
    return { kind: 'working' };
  }
  return composer;
}

/** Also used to confirm the composer emptied while a submitted rules message is working. */
export function cursorComposer(lines: string[]): Screen {
  if (trustDialog(lines)) return { kind: 'trust' };
  // The CLI has exited. The slash menu can still be on screen above the shell prompt.
  if (lines.some((line) => /To resume this session:/.test(line))) return { kind: 'unknown' };

  const footer = lines.findLastIndex((line) => /^\s+Grok\s+\d/.test(line));
  if (footer < 0) return slashEntry(lines);

  // The workspace path sits under the model line. Anything else below the footer is not this composer.
  const trailing = lines.slice(footer + 1).filter((line) => line.trim());
  if (trailing.length > 1 || trailing.some((line) => /^\s*→/.test(line))) return { kind: 'unknown' };

  let prompt = footer - 1;
  while (prompt >= 0 && !/^\s*→/.test(lines[prompt] ?? '')) prompt--;
  if (prompt < 0) return { kind: 'unknown' };
  const typed = (lines[prompt] ?? '').replace(/^\s*→/, '').replace(/\s*ctrl\+c to stop\s*$/, '').trim();
  if (lines.slice(prompt + 1, footer).some((line) => line.trim())) return { kind: 'unsent' };
  return typed === '' || EMPTY_PROMPT.has(typed) ? { kind: 'idle' } : { kind: 'unsent' };
}

// The active trust dialog has the question, both choices, and the navigation footer.
// A quoted dialog with a composer below it is not a prompt.
function trustDialog(lines: string[]): boolean {
  const text = lines.join('\n');
  if (!/Do you trust the contents of this/.test(text) || !/directory\?/.test(text)) return false;
  if (!/\[a\] Trust this workspace/.test(text) || !/\[q\] Quit/.test(text)) return false;
  const nav = lines.findLastIndex((line) => /Use arrow keys to navigate, Enter to/.test(line));
  if (nav < 0) return false;
  return !lines.slice(nav + 1).some((line) => /^\s*→/.test(line) || /^\s+Grok\s+\d/.test(line));
}

// `/exit` opens a suggestion menu and the model footer leaves. That text is still unsent.
function slashEntry(lines: string[]): Screen {
  const typed = lines.findIndex((line) => /^\s*→\s+\S/.test(line) && !/\sExit\s*$/.test(line));
  const menu = lines.some((line) => /^\s*→?\s*\/\S+\s+Exit\s*$/.test(line));
  return typed >= 0 && menu ? { kind: 'unsent' } : { kind: 'unknown' };
}
