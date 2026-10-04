// ANSI styling as herdr's `pane read --format ansi` reads it off a pane: the escape sequences
// a CLI wrapped around its text. Matching always runs on the plain form; the styling answers
// one question, the composer's — is the input line's text all dim, a greyed suggestion rather
// than something typed. Nothing here moves the cursor or writes to a pane.
//
// Observed on Claude Code 2.1.289 (test/fixtures/claude-code/2.1.289/README.md): a greyed
// suggestion is `ESC[0m ESC[2m` … `ESC[0m` — faint — while typed text carries no styling at
// all. Faint is the only placeholder style: a colour, however grey it renders, is a colour,
// and reading one as a placeholder was a guess this module no longer makes.

// A CSI sequence (an SGR ends in `m`), or an OSC title string. Visible output holds little
// else, and what it does hold is not text.
const ESCAPES = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// The faint state one SGR sequence leaves the pen in. `0` and `22` lift it; `2` sets it. The
// extended colours — foreground, background (48), underline (58) — carry their payload in
// sub-parameters (5;n or 2;r;g;b) whose numbers are never the faint switch.
export function sgrDim(sequence: string, faint: boolean): boolean {
  const params = sequence.slice(2, -1).split(';').map((part) => (part === '' ? '0' : part));
  let faintNow = faint;
  for (let i = 0; i < params.length; i++) {
    const n = Number(params[i]);
    if (!Number.isInteger(n)) continue;
    if (n === 0 || n === 22) faintNow = false;
    if (n === 2) faintNow = true;
    if (n === 38 || n === 48 || n === 58) {
      const mode = Number(params[i + 1]);
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
    }
  }
  return faintNow;
}

/** The text of a styled pane read, without its escape sequences. */
export function stripSgr(text: string): string {
  return text.replace(ESCAPES, '');
}

/**
 * Whether every visible character after the first `skip` ones is faint, so the line holds a
 * greyed suggestion rather than text. Whitespace is not read, mirroring the typed text the
 * caller trims; an empty remainder is dim, as an empty box is. A character without any
 * styling is plain text, so a plain source answers false and the placeholder list alone
 * decides — the fallback for an herdr without `--format ansi`.
 */
export function allDimAfter(styled: string, skip: number): boolean {
  let passed = 0;
  let faint = false;
  let cursor = 0;
  // The characters before an escape, then the escape; then the rest after the last one.
  const read = (chunk: string): boolean => {
    for (const ch of chunk) {
      if (/\s/.test(ch)) continue;
      passed++;
      if (passed > skip && !faint) return false;
    }
    return true;
  };
  for (const match of styled.matchAll(ESCAPES)) {
    if (!read(styled.slice(cursor, match.index))) return false;
    if (match[0].endsWith('m')) faint = sgrDim(match[0], faint);
    cursor = match.index + match[0].length;
  }
  return read(styled.slice(cursor));
}
