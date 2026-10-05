// Text with the terminal taken out of it.
//
// Everything `team` prints that came from a screen — or from any string a caller could build —
// has to survive a terminal that would act on it: an escape sequence in a pane's line, a seat's
// name or a record's reason would move the cursor, clear the screen, or restyle everything after
// it, and an invisible format character would display other words than the string holds, or hide
// them. `plainText` is the one cleaning: escape sequences removed whole, control characters and
// the invisible format characters gone, the line breaks kept. `plainLine` is it with the line
// breaks folded — one line in, one line out — for the fields and the detail lines a record
// writer says. `plainPaneText` is `plainText` plus the per-line cut the pane excerpts use.

/** Strips string sequences (OSC, DCS, APC, PM, SOS) and their payloads in one linear pass.
 *  OSC sequences terminate at BEL (\x07) or ST (7-bit ESC \ or 8-bit C1 \x9c).
 *  DCS, APC, PM and SOS sequences terminate only at ST (7-bit ESC \ or 8-bit C1 \x9c).
 *  An unterminated sequence drops everything to the end of the text. */
export function stripControlStrings(text: string): string {
  const slices: string[] = [];
  let plainStart = 0;
  // States: 0: PLAIN, 1: PLAIN_ESC, 2: IN_OSC, 3: IN_OSC_ESC, 4: IN_OTHER, 5: IN_OTHER_ESC
  let state = 0;
  let escCount = 0;

  // Invariant, both halves:
  // - No output character comes from inside a string sequence.
  // - No plain input character outside every sequence is missing from the scanner's output.
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    switch (state) {
      case 0: // PLAIN
        if (c === '\x1b') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 1;
          escCount = 1;
        } else if (c === '\x9d') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 2;
        } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 4;
        }
        break;
      case 1: // PLAIN_ESC
        if (c === ']') {
          state = 2;
          escCount = 0;
        } else if (c === 'P' || c === 'X' || c === '^' || c === '_') {
          state = 4;
          escCount = 0;
        } else if (c === '\x1b') {
          escCount++;
        } else if (c === '\x9d') {
          // Drop pending ESC: it was followed by a string opener and must not reach across the removed string.
          state = 2;
          escCount = 0;
        } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
          // Drop pending ESC: it was followed by a string opener and must not reach across the removed string.
          state = 4;
          escCount = 0;
        } else {
          slices.push('\x1b'.repeat(escCount));
          escCount = 0;
          plainStart = i;
          state = 0;
        }
        break;
      case 2: // IN_OSC
        if (c === '\x07' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          state = 3;
        }
        break;
      case 3: // IN_OSC_ESC
        if (c === '\\' || c === '\x07' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          // stay in 3 (IN_OSC_ESC)
        } else {
          state = 2;
        }
        break;
      case 4: // IN_OTHER
        if (c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          state = 5;
        }
        break;
      case 5: // IN_OTHER_ESC
        if (c === '\\' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          // stay in 5 (IN_OTHER_ESC)
        } else {
          state = 4;
        }
        break;
    }
  }

  if (state === 0) {
    if (plainStart === 0 && slices.length === 0) return text;
    if (plainStart < text.length) slices.push(text.slice(plainStart));
  } else if (state === 1) {
    slices.push('\x1b'.repeat(escCount));
  }
  return slices.join('');
}

/** A string as it is safe to print: every escape sequence is removed whole — a CSI's private
 *  parameters among them, and the payload of a string sequence (OSC, DCS, APC, PM, SOS),
 *  whichever introducer and terminator are mixed, 7-bit `ESC x` or its one-byte C1 form, `ESC \`
 *  or C1 ST, or BEL to close an OSC; one left unterminated goes to the end of the text — and
 *  every control character but the line break, carriage returns, bells and escape characters
 *  among them — and every invisible format character that would change how the rest is
 *  displayed or hide it. The line breaks are kept: a multi-line detail stays multi-line. */
export function plainText(text: string): string {
  return stripControlStrings(
    text
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // A one-byte C1 CSI may be written as its introducer plus the 7-bit tail, `\x9b[2J`: the
      // `[` belongs to the mangled sequence, and the whole of it goes, not the introducer alone.
      .replace(/\x9b\[?[0-?]*[ -/]*[@-~]/g, ''),
  )
    .replace(/\x1b./g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    // The invisible format characters (Unicode category Cf), exactly the ones whose effect is on
    // what is displayed rather than on the text itself: the bidi embeddings, overrides and
    // isolates (U+202A–U+202E, U+2066–U+2069), the direction marks (U+061C, U+200E, U+200F), the
    // zero-width characters (U+200B–U+200D, U+2060) and the byte-order mark (U+FEFF). A terminal
    // that honours them displays other words than the string holds, or hides words; ordinary
    // letters of every script are untouched.
    .replace(/[؜​-‏‪-‮⁠⁦-⁩﻿]/g, '');
}

/** `plainText` with the line breaks folded: one line in, one line out, whatever the caller
 *  built. A run of line feeds becomes one space — every word stays, the field is never cut —
 *  so a record's field or a detail line can never open a second physical line. */
export function plainLine(text: string): string {
  return plainText(text).replace(/\n+/g, ' ');
}

/** Pane text as it is safe to show (`plainText`), each line cut to `limit` characters. Pane text
 *  is the one text `team` says that it did not write itself: a carriage return in it would
 *  overwrite the report that carries it. */
export function plainPaneText(text: string, limit = 200): string {
  return plainText(text)
    .split('\n')
    .map((line) => (line.length > limit ? `${line.slice(0, limit)}…` : line))
    .join('\n');
}
