import type { Screen } from '../watch/screen.ts';

/** Visible text captured from Antigravity (agy 1.2.16). Unknown layouts never permit input. */
export function antigravityScreen(lines: string[]): Screen {
  // Herdr can lag a state transition. An active turn never permits a first message or an exit.
  if (lines.some((line) => /\bGenerating\.\.\./.test(line))) return { kind: 'unknown' };
  return antigravityComposer(lines);
}

/** Also used to confirm the composer emptied while a submitted rules message is working. */
export function antigravityComposer(lines: string[]): Screen {
  const text = lines.join('\n');
  const hasTrustQuestion = /Do you trust the contents of this project\?/i.test(text);
  const hasTrustChoice = />\s*Yes, I trust this folder/i.test(text);
  const hasConfirmFooter = lines.some((line) => /enter Confirm/i.test(line));

  // The active trust dialog has the question, the selectable choice, and the navigation footer.
  // A quoted dialog in an earlier turn has composer borders below it.
  if (hasTrustQuestion && hasTrustChoice && hasConfirmFooter) {
    const lastRule = lines.findLastIndex((line) => /^\s*[─━]{8,}\s*$/.test(line));
    const confirmIdx = lines.findLastIndex((line) => /enter Confirm/i.test(line));
    if (confirmIdx > lastRule) return { kind: 'trust' };
  }

  // The bottom border of the composer box
  let bottomBorder = -1;
  let topBorder = -1;
  let prompt = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (/^\s*[─━]{8,}\s*$/.test(line)) {
      if (bottomBorder === -1) {
        bottomBorder = i;
      } else if (topBorder === -1 && prompt !== -1) {
        topBorder = i;
        break;
      }
    } else if (bottomBorder !== -1 && prompt === -1 && /^\s*>\s*/.test(line)) {
      prompt = i;
    }
  }

  if (topBorder < 0 || bottomBorder < 0 || prompt <= topBorder || prompt >= bottomBorder) {
    return { kind: 'unknown' };
  }

  // The footer below the composer must match a known agy status or shortcut footer
  const belowBottom = lines.slice(bottomBorder + 1);
  const validFooter = belowBottom.some((line) =>
    /(\? for shortcuts|Gemini\s+\d|esc to cancel|>\s*\/exit\s+Exit)/i.test(line),
  );
  if (!validFooter) return { kind: 'unknown' };

  const promptLine = lines[prompt] as string;
  const typed = promptLine.replace(/^\s*>\s*/, '').trim();
  const additional = lines.slice(prompt + 1, bottomBorder);
  if (additional.some((line) => line.trim() !== '')) return { kind: 'unsent' };

  return typed === '' ? { kind: 'idle' } : { kind: 'unsent' };
}
