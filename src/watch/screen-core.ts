// The screen core. Stage order, dialog primitives, the four composer modes and the
// safety floor live here, never in a profile. A profile is data: it can add a
// pattern, and it cannot move a stage or turn the floor off.
import { allDimAfter, hasSgr, stripSgr } from '../ansi.ts';
import type { Screen } from './screen.ts';
import type { LinePattern, Rule, ScreenData, Wrap } from './screen-data.ts';

export type { Composer, FallbackRule, LinePattern, Placeholder, PlaceholderStyle, Rule, ScreenData, Stage, Wrap } from './screen-data.ts';

const BUDGET_MS = 100;

// The rule a `below_last_rule` pattern has to sit under. It is the core's, not the profile's.
const RULE_LINE = /^\s*[─━]{8,}\s*$/;

// The safety floor's markers, matched without case: a dialog's wording is not always title-case
// (`Press enter to confirm or esc to cancel`). RFC 0002 § 4.1 permits it.
const FLOOR_PHRASES = ['do you want to', 'esc to cancel', 'enter confirm', 'enter continue', 'esc quit', 'esc skip', '↑/↓'];

export type ReadClock = { now(): number; budgetMs: number };

/**
 * The index of the composer's status line in the window, or -1. A `status-last` composer pins it
 * as the last non-blank line; a `status-then-one` composer allows one chrome line below it. The
 * classification and the quota read both take their line from here, so the two cannot disagree
 * about which line the composer's status line is.
 */
function statusIndex(
  composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>,
  lines: string[],
  allowOneTrailing: boolean,
  tick: () => boolean,
): number | 'stop' {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return 'stop';
    if (!composer.statusLine.test(lines[i] ?? '')) continue;
    const trailing = lines.slice(i + 1).filter((line) => line.trim());
    if (allowOneTrailing) {
      if (trailing.length > 0 && (trailing.length > 1 || composer.prompt.test(trailing[0] ?? ''))) return -1;
    } else if (trailing.length > 0) return -1;
    return i;
  }
  return -1;
}

/**
 * The one line a quota figure may be read from: the composer's own status row, or null when the
 * window shows none. A dialog, a transcript line, the input box — anything the seat printed or
 * typed — is never the row. The caller still has to know the screen is a composer screen.
 */
export function statusRowOf(data: ScreenData, lines: string[]): string | null {
  const composer = data.composer;
  if (composer.mode !== 'status-last' && composer.mode !== 'status-then-one') return null;
  const at = statusIndex(composer, lines, composer.mode === 'status-then-one', () => false);
  return at === 'stop' || at < 0 ? null : (lines[at] ?? null);
}

export type Fold = { count: number; rows: string[]; width: number };

/** The input box a composer draws for its current text: the first line after the prompt, the
 *  continuation rows under it, the column those rows start at (the prompt's own width plus
 *  the separator the input row draws), and the profile's wrap rule when a capture shows how
 *  the box continues a line onto its next row. */
export type Box = { first: string; indent: number; rows: string[]; wrap?: Wrap };

/**
 * The fold-shaped frame a window shows, or null: the marker row and the count it names (any
 * integer, zero included), the tail rows below it, the box's two rules around both, and a footer
 * under the bottom one. The top rule's width is the width the text wrapped at. The shape alone;
 * whether the fold holds the typed text is the caller's to verify.
 */
function foldFrame(data: ScreenData, lines: string[]): Fold | null {
  const composer = data.composer;
  if (composer.mode !== 'two-rules-footer-below' || !composer.fold) return null;
  let marker = -1;
  let found: RegExpExecArray | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = composer.fold.exec(lines[i] ?? '');
    if (hit) { marker = i; found = hit; break; }
  }
  if (marker < 0 || !found) return null;
  let bottom = -1;
  for (let i = marker + 1; i < lines.length; i++) {
    if (composer.rule.test(lines[i] ?? '')) { bottom = i; break; }
  }
  if (bottom < 0) return null;
  let top = -1;
  for (let i = marker - 1; i >= 0; i--) {
    if (composer.rule.test(lines[i] ?? '')) { top = i; break; }
  }
  if (top < 0) return null;
  const rows = lines.slice(marker + 1, bottom).filter((line) => line.trim());
  if (rows.length === 0) return null;
  if (!lines.slice(bottom + 1).some((line) => composer.footers.some((pattern) => pattern.test(line)))) return null;
  const count = Number(found[1]);
  if (!Number.isInteger(count)) return null;
  return { count, rows, width: (lines[top] ?? '').trim().length };
}

/**
 * The fold a `two-rules-footer-below` composer's window shows, or null. A marker whose count is
 * zero names no hidden rows to compare against, so it is no fold; it is still a marker, and
 * `foldMarked` catches it.
 */
export function foldOf(data: ScreenData, lines: string[]): Fold | null {
  const frame = foldFrame(data, lines);
  if (frame === null || frame.count < 1) return null;
  return frame;
}

/**
 * Whether the window shows a fold marker at all, whatever count it names: a marker claiming zero
 * hidden rows (or a count a fold could not have) is still a box that is not showing the whole
 * text, and it must never be taken for an ordinary unsent box and submitted unverified.
 */
export function foldMarked(data: ScreenData, lines: string[]): boolean {
  return foldFrame(data, lines) !== null;
}

type Hit = { kind: Screen['kind']; from: number; input: number; rows?: string[] } | { kind: 'unknown' } | { kind: 'stop' };

/** `lines` is already the window: the last 20 lines, each keeping any ANSI styling. Matching
 *  runs on each line's plain form, trimmed at the end; the styled form is kept for the one
 *  question styling can answer, whether the composer's input line is all dim. */
function plainLines(lines: string[]): string[] {
  return lines.map((line) => stripSgr(line).trimEnd());
}

/** `lines` is already the window: the last 20 lines, each trimmed at the end. */
export function classifyLines(data: ScreenData, lines: string[], clock?: ReadClock): Screen {
  const now = clock?.now ?? Date.now;
  const budget = clock?.budgetMs ?? BUDGET_MS;
  const start = now();
  const tick = () => now() - start > budget;
  const plain = plainLines(lines);
  const order: [Screen['kind'], ScreenData['trust']][] = [
    ['unknown', data.unknown],
    ['trust', data.trust],
    ['permission', data.permission],
    ['question', data.question],
    ['working', data.working],
  ];
  for (const [kind, stage] of order) {
    if (!stage) continue;
    for (const rule of stage.rules) {
      const hit = ruleMatches(data, plain, rule, tick);
      if (hit === 'stop') return { kind: 'unknown' };
      if (hit) return { kind };
    }
  }
  const composed = compose(data, plain, lines, tick);
  if (composed.kind === 'stop' || composed.kind === 'unknown') return { kind: 'unknown' };
  if (composed.kind !== 'idle' && composed.kind !== 'unsent') return { kind: composed.kind };
  const marked = floorHits(plain, composed.from, composed.input, data.chrome, tick);
  if (marked === 'stop' || marked) return { kind: 'unknown' };
  return { kind: composed.kind };
}

/**
 * The composer alone, for a turn that is still running. The unknown stage is
 * read first, as in the full classification, and the floor still applies.
 */
export function composeLines(data: ScreenData, lines: string[], clock?: ReadClock): Screen {
  const now = clock?.now ?? Date.now;
  const budget = clock?.budgetMs ?? BUDGET_MS;
  const start = now();
  const tick = () => now() - start > budget;
  const plain = plainLines(lines);
  if (data.unknown) {
    for (const rule of data.unknown.rules) {
      const hit = ruleMatches(data, plain, rule, tick);
      if (hit === 'stop') return { kind: 'unknown' };
      if (hit) return { kind: 'unknown' };
    }
  }
  const composed = compose(data, plain, lines, tick);
  if (composed.kind === 'stop' || composed.kind === 'unknown') return { kind: 'unknown' };
  if (composed.kind !== 'idle' && composed.kind !== 'unsent') return { kind: composed.kind };
  const marked = floorHits(plain, composed.from, composed.input, data.chrome, tick);
  if (marked === 'stop' || marked) return { kind: 'unknown' };
  return { kind: composed.kind };
}

/**
 * The input box a composer draws for its current text, or null when the composer does not read
 * `unsent`: an idle box holds nothing, and every other shape is not the box. The rows are the
 * ones the mode's own frame delimits — between the prompt row and the box's closing line; the
 * `status-then-one` fallback (the captured completion frame) delimits nothing, so its box is
 * its one input row, the popup rows below it being its filter's to exclude. The caller compares
 * the box to the text it typed; nothing here decides that.
 */
export function composerBox(data: ScreenData, lines: string[]): Box | null {
  const plain = plainLines(lines);
  const hit = compose(data, plain, lines, () => false);
  if (hit.kind === 'stop' || hit.kind === 'unknown') return null;
  if (hit.kind !== 'unsent') return null;
  const input = plain[hit.input] ?? '';
  const found = data.composer.prompt.exec(input);
  if (!found) return null;
  let rest = input.slice(found[0].length);
  const suffix: RegExp | null | undefined = 'stripSuffix' in data.composer ? data.composer.stripSuffix : undefined;
  if (suffix) rest = rest.replace(suffix, '');
  const indent = found[0].length + rest.length - rest.trimStart().length;
  const rows = hit.rows ?? [];
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return { first: rest.trimStart(), indent, rows, wrap: 'wrap' in data.composer ? data.composer.wrap : undefined };
}

function ruleMatches(data: ScreenData, lines: string[], rule: Rule, tick: () => boolean): boolean | 'stop' {
  const where = rule.onFooter ? [footerLine(data, lines)] : lines;
  if (rule.any) {
    const hit = anyLine(where, rule.any, tick);
    if (hit === 'stop') return 'stop';
    if (!hit) return false;
  }
  if (rule.all) {
    for (const pattern of rule.all) {
      const hit = lineSomewhere(where, pattern, tick);
      if (hit === 'stop') return 'stop';
      if (!hit) return false;
    }
  }
  if (rule.footer !== undefined) {
    if (footerLine(data, lines) !== rule.footer) return false;
  }
  if (rule.withoutRule) {
    if (tick()) return 'stop';
    if (findLast(lines, (line) => RULE_LINE.test(line)) >= 0) return false;
  }
  if (rule.belowLastRule) {
    if (tick()) return 'stop';
    // A pattern sits below a composer rule. A window with no rule line is not
    // below one: a dialog that fills the pane says so with `without_rule`.
    const ruleAt = findLast(lines, (line) => RULE_LINE.test(line));
    if (ruleAt < 0) return false;
    const at = findLast(lines, (line) => rule.belowLastRule?.test(line) ?? false);
    if (at < 0 || at <= ruleAt) return false;
  }
  if (rule.noneAfter) {
    let anchor = -1;
    for (let i = 0; i < lines.length; i++) {
      const hit = matches(lines[i] ?? '', rule.noneAfter.anchor, tick);
      if (hit === 'stop') return 'stop';
      if (hit) anchor = i;
    }
    if (anchor < 0) return false;
    for (let i = anchor + 1; i < lines.length; i++) {
      const later = anyLine([lines[i] ?? ''], rule.noneAfter.patterns, tick);
      if (later === 'stop') return 'stop';
      if (later) return false;
    }
  }
  return true;
}

function anyLine(lines: string[], patterns: LinePattern[], tick: () => boolean): boolean | 'stop' {
  for (const pattern of patterns) {
    const hit = lineSomewhere(lines, pattern, tick);
    if (hit === 'stop') return 'stop';
    if (hit) return true;
  }
  return false;
}

function lineSomewhere(lines: string[], pattern: LinePattern, tick: () => boolean): boolean | 'stop' {
  for (const line of lines) {
    const hit = matches(line, pattern, tick);
    if (hit === 'stop') return 'stop';
    if (hit) return true;
  }
  return false;
}

/**
 * The line a rule's footer must be: the last non-blank one. The composer's own chrome is the one
 * thing allowed below it — a `status-last` mode pins the status line to the pane's last line, and
 * a dialog drawn above it is still the dialog its footer belongs to. Any other line below the
 * footer means the footer is not the dialog's, and the rule doesn't match.
 */
function footerLine(data: ScreenData, lines: string[]): string {
  const nonBlank = lines.filter((line) => line.trim());
  const last = nonBlank[nonBlank.length - 1] ?? '';
  const composer = data.composer;
  if (composer.mode === 'status-last' && composer.statusLine.test(last)) {
    return (nonBlank[nonBlank.length - 2] ?? '').trim();
  }
  return last.trim();
}

function matches(line: string, pattern: LinePattern, tick: () => boolean): boolean | 'stop' {
  if (tick()) return 'stop';
  if (!pattern.match.test(line)) return false;
  for (const except of pattern.except) {
    if (tick()) return 'stop';
    if (except.test(line)) return false;
  }
  return true;
}

/** `plain` is the window's plain form; `styled` the window itself, for the input line's dim question. */
function compose(data: ScreenData, plain: string[], styled: string[], tick: () => boolean): Hit {
  const composer = data.composer;
  if (composer.mode === 'box-to-rule') return boxToRule(plain, styled, composer, tick);
  if (composer.mode === 'status-last') return statusLast(plain, styled, composer, tick, false);
  if (composer.mode === 'status-then-one') return statusThenOne(plain, styled, composer, tick);
  return twoRules(plain, styled, composer, tick);
}

function boxToRule(lines: string[], styled: string[], composer: Extract<ScreenData['composer'], { mode: 'box-to-rule' }>, tick: () => boolean): Hit {
  let input = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    if (composer.prompt.test(lines[i] ?? '')) { input = i; break; }
  }
  if (input < 0) return { kind: 'unknown' };
  // The frame is the box itself: a closing rule under this prompt. A rule anywhere
  // above, or a rule with shell output under it, is not the box. A shell's last
  // prompt never has that closing rule.
  let close = -1;
  for (let i = input + 1; i < lines.length; i++) {
    if (tick()) return { kind: 'stop' };
    if (composer.rule.test(lines[i] ?? '')) { close = i; break; }
  }
  if (close < 0) return { kind: 'unknown' };
  const above = input > 0 && composer.rule.test(lines[input - 1] ?? '');
  let footer = false;
  const rawFooters: string[] = [];
  for (let j = close + 1; j < lines.length; j++) {
    if (tick()) return { kind: 'stop' };
    const raw = lines[j] ?? '';
    if (raw.trim()) rawFooters.push(raw);
  }
  if (composer.footers.length > 0 && rawFooters.length === composer.footers.length) {
    footer = composer.footers.every((pattern, idx) => pattern.test(rawFooters[idx] ?? ''));
  }
  // The opening rule on the line directly above, or the ordered footer frame
  // (every pattern matched in sequence, equal count) when that rule has
  // scrolled out of the window.
  if (!above && !footer) return { kind: 'unknown' };
  const from = above ? input - 1 : input;
  const rows = lines.slice(input + 1, close);
  for (let i = input + 1; i < close; i++) {
    if ((lines[i] ?? '').trim()) return { kind: 'unsent', from, input, rows };
  }
  const typed = (lines[input] ?? '').replace(composer.prompt, '').trim();
  return { kind: placeholder(typed, composer, lines[input] ?? '', styled[input]) ? 'idle' : 'unsent', from, input, rows };
}

function statusLast(
  lines: string[],
  styled: string[],
  composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>,
  tick: () => boolean,
  allowOneTrailing: boolean,
): Hit {
  const status = statusIndex(composer, lines, allowOneTrailing, tick);
  if (status === 'stop') return { kind: 'stop' };
  if (status < 0) return { kind: 'unknown' };
  let input = status - 1;
  while (input >= 0 && !composer.prompt.test(lines[input] ?? '')) input--;
  if (input < 0) return { kind: 'unknown' };
  const rows = lines.slice(input + 1, status);
  for (let i = input + 1; i < status; i++) if ((lines[i] ?? '').trim()) return { kind: 'unsent', from: input, input, rows };
  return { kind: placeholder(stripTyped(lines[input] ?? '', composer), composer, lines[input] ?? '', styled[input]) ? 'idle' : 'unsent', from: input, input, rows };
}

function statusThenOne(lines: string[], styled: string[], composer: Extract<ScreenData['composer'], { mode: 'status-then-one' }>, tick: () => boolean): Hit {
  const found = statusLast(lines, styled, composer, tick, true);
  if (found.kind !== 'unknown') return found;
  // No status line: the fallback rules decide. Anything they don't name is unknown.
  const hasStatus = lines.some((line) => composer.statusLine.test(line));
  if (hasStatus) return { kind: 'unknown' };
  for (const rule of composer.fallback) {
    let ok = true;
    for (const pattern of rule.all) {
      const hit = lineSomewhere(lines, pattern, tick);
      if (hit === 'stop') return { kind: 'stop' };
      if (!hit) { ok = false; break; }
    }
    if (ok) {
      // The floor's region starts at the prompt, the composer's top boundary.
      // A phrase in the transcript above it is not the floor's to read.
      const input = lines.findIndex((line) => composer.prompt.test(line));
      return { kind: rule.kind, from: input < 0 ? 0 : input, input };
    }
  }
  return { kind: 'unknown' };
}

function twoRules(lines: string[], styled: string[], composer: Extract<ScreenData['composer'], { mode: 'two-rules-footer-below' }>, tick: () => boolean): Hit {
  let bottom = -1;
  let top = -1;
  let input = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    const line = lines[i] ?? '';
    if (composer.rule.test(line)) {
      if (bottom === -1) bottom = i;
      else if (top === -1 && input !== -1) { top = i; break; }
    } else if (bottom !== -1 && input === -1 && composer.prompt.test(line)) input = i;
  }
  if (top < 0 || bottom < 0 || input <= top || input >= bottom) return { kind: 'unknown' };
  let footer = false;
  for (let i = bottom + 1; i < lines.length; i++) {
    if (tick()) return { kind: 'stop' };
    if (composer.footers.some((pattern) => pattern.test(lines[i] ?? ''))) footer = true;
  }
  if (!footer) return { kind: 'unknown' };
  const rows = lines.slice(input + 1, bottom);
  if (lines.slice(input + 1, bottom).some((line) => line.trim())) return { kind: 'unsent', from: top, input, rows };
  const typed = (lines[input] ?? '').replace(composer.prompt, '').trim();
  return { kind: placeholder(typed, composer, lines[input] ?? '', styled[input]) ? 'idle' : 'unsent', from: top, input, rows };
}

function stripTyped(line: string, composer: { prompt: RegExp; stripSuffix?: RegExp | null }): string {
  const stripped = composer.stripSuffix ? line.replace(composer.prompt, '').replace(composer.stripSuffix, '') : line.replace(composer.prompt, '');
  return stripped.trim();
}

// A placeholder, not text. When the composer says its suggestions render dim and the input
// line carries any styling at all, the styling decides alone: all faint past the prompt is a
// greyed suggestion, anything else is text — the list is not asked, so no suggestion's
// styling can lend its words to typed characters after it. A line without styling (a plain
// read, an old herdr) leaves the list to decide, as does a composer without the style.
function placeholder(
  typed: string,
  composer: { prompt: RegExp; placeholders: ScreenData['composer']['placeholders']; placeholderStyle?: ScreenData['composer']['placeholderStyle'] },
  plainLine: string,
  styledLine: string | undefined,
): boolean {
  if (composer.placeholderStyle === 'dim' && styledLine !== undefined && hasSgr(styledLine)) {
    const hit = composer.prompt.exec(plainLine);
    const skip = hit === null ? 0 : plainLine.slice(0, hit.index + hit[0].length).replace(/\s/g, '').length;
    return allDimAfter(styledLine, skip);
  }
  return composer.placeholders.some((entry) => ('equals' in entry ? typed === entry.equals : typed.startsWith(entry.prefix)));
}

function floorHits(lines: string[], from: number, input: number, chrome: RegExp[], tick: () => boolean): boolean | 'stop' {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (tick()) return 'stop';
    const line = lines[i] ?? '';
    if (chrome.some((pattern) => pattern.test(line))) continue;
    if (i !== input && choiceLine(line) && lines.slice(i + 1).some((later) => twoLine(later))) return true;
    const lower = line.toLowerCase();
    if (FLOOR_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  }
  return false;
}

function choiceLine(line: string): boolean {
  return /^\s*[❯›>]\s*1\.\s/.test(line);
}

function twoLine(line: string): boolean {
  return /^\s*[❯›>]?\s*2\.\s/.test(line);
}

function findLast(lines: string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i] ?? '')) return i;
  return -1;
}
