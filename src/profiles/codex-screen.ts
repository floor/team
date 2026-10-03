import type { Screen } from '../watch/screen.ts';

/** Visible text captured from Codex 0.157.0. Unknown layouts never permit input. */
export function codexScreen(lines: string[]): Screen {
  if (lines.some((line) => /\bmodel:\s+loading\b/.test(line))) return { kind: 'unknown' };
  const composer = codexComposer(lines);
  // A trust or update dialog is read before the working line, as for claude-code: it can stay up
  // while a turn runs, and it is the operator's to answer, not input to type past.
  if (composer.kind === 'trust' || composer.kind === 'question') return composer;
  // Herdr can lag a state transition. An active turn never permits a first message or an exit,
  // and is a working observation even while herdr's status has not caught up.
  if (lines.some((line) => /esc to interrupt/.test(line))) return { kind: 'working' };
  return composer;
}

/** Also used to confirm the composer emptied while a submitted rules message is working. */
export function codexComposer(lines: string[]): Screen {
  const text = lines.join('\n');
  const last = lines.filter((line) => line.trim()).at(-1)?.trim() ?? '';
  // Match the active choice footer too: quoted dialogs in an earlier turn are not prompts.
  if (last === 'enter continue · esc quit' && /Trust this folder\?/.test(text)
    && /^\s*›?\s*1\. Trust and continue\s*$/m.test(text)) return { kind: 'trust' };
  if (last === 'enter continue · esc skip' && /Update available ·/.test(text)
    && /^\s*›?\s*1\. Update now\b/m.test(text)) return { kind: 'question' };

  // The status footer belongs below the composer, not in a transcript or a shell prompt.
  const footer = lines.findLastIndex((line) => /^\s+GPT-\d[\w.-]*\s+[^·]*·/.test(line));
  if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return { kind: 'unknown' };
  let prompt = footer - 1;
  while (prompt >= 0 && !/^\s*›(?:\s|$)/.test(lines[prompt] as string)) prompt--;
  if (prompt < 0) return { kind: 'unknown' };
  const typed = (lines[prompt] as string).replace(/^\s*›/, '').trim();
  if (lines.slice(prompt + 1, footer).some((line) => line.trim())) return { kind: 'unsent' };
  return typed === '' || typed === 'Ask Codex to do anything' ? { kind: 'idle' } : { kind: 'unsent' };
}
