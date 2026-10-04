// ANSI styling as herdr's `pane read --format ansi` reads it off a pane: the escape sequences
// a CLI wrapped around its text. Matching always runs on the plain form; the styling answers
// one question, the composer's — is the input line's text all dim, a greyed suggestion rather
// than something typed. Nothing here moves the cursor or writes to a pane.
//
// Observed on Claude Code 2.1.289 (test/fixtures/claude-code/2.1.289/README.md): a greyed
// suggestion is `ESC[0m ESC[2m` … `ESC[0m` — faint — while typed text carries no styling at
// all. The grey family below covers the forms a terminal's "grey text" takes (bright black,
// the 256-colour greys, a true-colour grey) so a theme change stays a placeholder; anything
// else — a colour, white, bold — reads as text.

// A CSI sequence (an SGR ends in `m`), or an OSC title string. Visible output holds little
// else, and what it does hold is not text.
const ESCAPES = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// The 256-colour cube's greys: the bright-black slot and the 240–249 ramp.
function grey256(n: number): boolean {
  return n === 8 || (n >= 240 && n <= 249);
}

// The dim state one SGR sequence leaves the pen in. `0` and `22` lift faint; `39` and any
// other foreground colour lift grey.
export function sgrDim(sequence: string, faint: boolean, grey: boolean): { faint: boolean; grey: boolean } {
  const params = sequence.slice(2, -1).split(';').map((part) => (part === '' ? '0' : part));
  let faintNow = faint;
  let greyNow = grey;
  for (let i = 0; i < params.length; i++) {
    const n = Number(params[i]);
    if (!Number.isInteger(n)) continue;
    if (n === 0 || n === 22) faintNow = false;
    if (n === 2) faintNow = true;
    if (n === 0 || n === 39) greyNow = false;
    if (n === 90) greyNow = true;
    if ((n >= 30 && n <= 37) || (n >= 91 && n <= 97)) greyNow = false;
    if (n === 38) {
      const mode = Number(params[i + 1]);
      if (mode === 5) {
        const color = Number(params[i + 2]);
        greyNow = Number.isInteger(color) && grey256(color);
        i += 2;
      } else if (mode === 2) {
        const r = Number(params[i + 2]);
        const g = Number(params[i + 3]);
        const b = Number(params[i + 4]);
        // A grey: the three channels agree and stay dark enough that white — some themes'
        // plain text — is never one.
        greyNow = r === g && g === b && r <= 170;
        i += 4;
      }
    }
    // A background (48) or underline (58) colour carries the same sub-parameters; they say
    // nothing of the text's own colour, and walking into them would read their `2` as faint.
    if (n === 48 || n === 58) {
      const mode = Number(params[i + 1]);
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
    }
  }
  return { faint: faintNow, grey: greyNow };
}

/** The text of a styled pane read, without its escape sequences. */
export function stripSgr(text: string): string {
  return text.replace(ESCAPES, '');
}

/**
 * Whether every visible character after the first `skip` ones is faint or grey, so the line
 * holds a greyed suggestion rather than text. Whitespace is not read, mirroring the typed
 * text the caller trims; an empty remainder is dim, as an empty box is. A character without
 * any styling is plain text, so a plain source answers false and the placeholder list alone
 * decides — the fallback for an herdr without `--format ansi`.
 */
export function allDimAfter(styled: string, skip: number): boolean {
  let passed = 0;
  let faint = false;
  let grey = false;
  ESCAPES.lastIndex = 0;
  let match: RegExpExecArray | null;
  let cursor = 0;
  // The characters before an escape, then the escape; then the rest after the last one.
  const read = (chunk: string): boolean => {
    for (const ch of chunk) {
      if (/\s/.test(ch)) continue;
      passed++;
      if (passed > skip && !faint && !grey) return false;
    }
    return true;
  };
  while ((match = ESCAPES.exec(styled)) !== null) {
    if (!read(styled.slice(cursor, match.index))) return false;
    if (match[0].endsWith('m')) ({ faint, grey } = sgrDim(match[0], faint, grey));
    cursor = match.index + match[0].length;
  }
  return read(styled.slice(cursor));
}
