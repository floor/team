// The screen core. Stage order, dialog primitives, the four composer modes and the
// safety floor live here, never in a profile. A profile is data: it can add a
// pattern, and it cannot move a stage or turn the floor off.
import type { Screen } from './screen.ts';
import type { LinePattern, Rule, ScreenData } from './screen-data.ts';

export type { Composer, FallbackRule, LinePattern, Placeholder, Rule, ScreenData, Stage } from './screen-data.ts';

const BUDGET_MS = 100;

// The rule a `below_last_rule` pattern has to sit under. It is the core's, not the profile's.
const RULE_LINE = /^\s*[─━]{8,}\s*$/;

const FLOOR_PHRASES = ['Do you want to', 'Esc to cancel', 'enter Confirm', 'enter continue', 'esc quit', 'esc skip', '↑/↓'];

export type ReadClock = { now(): number; budgetMs: number };

type Hit = { kind: Screen['kind']; from: number; input: number } | { kind: 'unknown' } | { kind: 'stop' };

/** `lines` is already the window: the last 20 lines, each trimmed at the end. */
export function classifyLines(data: ScreenData, lines: string[], clock?: ReadClock): Screen {
  const now = clock?.now ?? Date.now;
  const budget = clock?.budgetMs ?? BUDGET_MS;
  const start = now();
  const tick = () => now() - start > budget;
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
      const hit = ruleMatches(lines, rule, tick);
      if (hit === 'stop') return { kind: 'unknown' };
      if (hit) return { kind };
    }
  }
  const composed = compose(data, lines, tick);
  if (composed.kind === 'stop' || composed.kind === 'unknown') return { kind: 'unknown' };
  if (composed.kind !== 'idle' && composed.kind !== 'unsent') return { kind: composed.kind };
  const marked = floorHits(lines, composed.from, composed.input, data.chrome, tick);
  if (marked === 'stop' || marked) return { kind: 'unknown' };
  return { kind: composed.kind };
}

/** The composer alone, for a turn that is still running. The floor still applies. */
export function composeLines(data: ScreenData, lines: string[], clock?: ReadClock): Screen {
  const now = clock?.now ?? Date.now;
  const budget = clock?.budgetMs ?? BUDGET_MS;
  const start = now();
  const tick = () => now() - start > budget;
  const composed = compose(data, lines, tick);
  if (composed.kind === 'stop' || composed.kind === 'unknown') return { kind: 'unknown' };
  if (composed.kind !== 'idle' && composed.kind !== 'unsent') return { kind: composed.kind };
  const marked = floorHits(lines, composed.from, composed.input, data.chrome, tick);
  if (marked === 'stop' || marked) return { kind: 'unknown' };
  return { kind: composed.kind };
}

function ruleMatches(lines: string[], rule: Rule, tick: () => boolean): boolean | 'stop' {
  if (rule.any) {
    const hit = anyLine(lines, rule.any, tick);
    if (hit === 'stop') return 'stop';
    if (!hit) return false;
  }
  if (rule.all) {
    for (const pattern of rule.all) {
      const hit = lineSomewhere(lines, pattern, tick);
      if (hit === 'stop') return 'stop';
      if (!hit) return false;
    }
  }
  if (rule.footer !== undefined) {
    const last = [...lines].reverse().find((line) => line.trim());
    if ((last ?? '').trim() !== rule.footer) return false;
  }
  if (rule.belowLastRule) {
    if (tick()) return 'stop';
    // No rule line counts as below one: today's check is `index > lastIndex`, and
    // lastIndex is -1 when the window has no rule. A later rule still hides a quoted dialog.
    const ruleAt = findLast(lines, (line) => RULE_LINE.test(line));
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

function matches(line: string, pattern: LinePattern, tick: () => boolean): boolean | 'stop' {
  if (tick()) return 'stop';
  if (!pattern.match.test(line)) return false;
  for (const except of pattern.except) {
    if (tick()) return 'stop';
    if (except.test(line)) return false;
  }
  return true;
}

function compose(data: ScreenData, lines: string[], tick: () => boolean): Hit {
  const composer = data.composer;
  if (composer.mode === 'box-to-rule') return boxToRule(lines, composer, tick);
  if (composer.mode === 'status-last') return statusLast(lines, composer, tick, false);
  if (composer.mode === 'status-then-one') return statusThenOne(lines, composer, tick);
  return twoRules(lines, composer, tick);
}

function boxToRule(lines: string[], composer: Extract<ScreenData['composer'], { mode: 'box-to-rule' }>, tick: () => boolean): Hit {
  let input = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    if (composer.prompt.test(lines[i] ?? '')) { input = i; break; }
  }
  if (input < 0) return { kind: 'unknown' };
  const from = boundaryBefore(lines, input, composer.rule);
  for (let i = input + 1; i < lines.length; i++) {
    if (tick()) return { kind: 'stop' };
    if (composer.rule.test(lines[i] ?? '')) break;
    if ((lines[i] ?? '').trim()) return { kind: 'unsent', from, input };
  }
  const typed = (lines[input] ?? '').replace(composer.prompt, '').trim();
  return { kind: placeholder(typed, composer.placeholders) ? 'idle' : 'unsent', from, input };
}

function statusLast(
  lines: string[],
  composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>,
  tick: () => boolean,
  allowOneTrailing: boolean,
): Hit {
  let status = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    if (composer.statusLine.test(lines[i] ?? '')) { status = i; break; }
  }
  if (status < 0) return { kind: 'unknown' };
  const trailing: string[] = [];
  for (let i = status + 1; i < lines.length; i++) if ((lines[i] ?? '').trim()) trailing.push(lines[i] ?? '');
  if (allowOneTrailing) {
    if (trailing.length > 1 || trailing.some((line) => composer.prompt.test(line))) return { kind: 'unknown' };
  } else if (trailing.length > 0) return { kind: 'unknown' };
  let input = status - 1;
  while (input >= 0 && !composer.prompt.test(lines[input] ?? '')) input--;
  if (input < 0) return { kind: 'unknown' };
  for (let i = input + 1; i < status; i++) if ((lines[i] ?? '').trim()) return { kind: 'unsent', from: input, input };
  return { kind: placeholder(stripTyped(lines[input] ?? '', composer), composer.placeholders) ? 'idle' : 'unsent', from: input, input };
}

function statusThenOne(lines: string[], composer: Extract<ScreenData['composer'], { mode: 'status-then-one' }>, tick: () => boolean): Hit {
  const found = statusLast(lines, composer, tick, true);
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
    if (ok) return { kind: rule.kind, from: 0, input: -1 };
  }
  return { kind: 'unknown' };
}

function twoRules(lines: string[], composer: Extract<ScreenData['composer'], { mode: 'two-rules-footer-below' }>, tick: () => boolean): Hit {
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
  if (lines.slice(input + 1, bottom).some((line) => line.trim())) return { kind: 'unsent', from: top, input };
  const typed = (lines[input] ?? '').replace(composer.prompt, '').trim();
  return { kind: placeholder(typed, composer.placeholders) ? 'idle' : 'unsent', from: top, input };
}

function boundaryBefore(lines: string[], input: number, rule: RegExp): number {
  for (let i = input - 1; i >= 0; i--) if (rule.test(lines[i] ?? '')) return i;
  return input;
}

function stripTyped(line: string, composer: { prompt: RegExp; stripSuffix?: RegExp | null }): string {
  const stripped = composer.stripSuffix ? line.replace(composer.prompt, '').replace(composer.stripSuffix, '') : line.replace(composer.prompt, '');
  return stripped.trim();
}

function placeholder(typed: string, list: ScreenData['composer']['placeholders']): boolean {
  return list.some((entry) => ('equals' in entry ? typed === entry.equals : typed.startsWith(entry.prefix)));
}

function floorHits(lines: string[], from: number, input: number, chrome: RegExp[], tick: () => boolean): boolean | 'stop' {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (tick()) return 'stop';
    const line = lines[i] ?? '';
    if (chrome.some((pattern) => pattern.test(line))) continue;
    if (i !== input && choiceLine(line) && lines.slice(i + 1).some((later) => twoLine(later))) return true;
    if (FLOOR_PHRASES.some((phrase) => line.includes(phrase))) return true;
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
