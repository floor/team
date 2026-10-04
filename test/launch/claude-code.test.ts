import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { boxHoldsText, deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { claudeBox } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/claude-code/2.1.289/${name}.txt`, import.meta.url), 'utf8');

/** The window the pane shows while a turn runs: the box back to empty, the footer's own line
 *  saying so. `deliverRules` observes this after the Enter. */
const busy = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5 · esc to interrupt\n`;

function delivery() {
  let raw = fixture('idle-suggestion-plain');
  let status = 'idle';
  let clock = 0;
  const calls: string[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = claudeBox(text); return true; },
    enter() { calls.push('Enter'); raw = busy; status = 'working'; return true; },
    foreground: () => ['claude'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, showText: (screen: string) => { raw = screen; } };
}

const ROGUE = '─'.repeat(40);

describe('Claude Code rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('claude-code', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('the captured typed box reads back as its text and is entered', () => {
    // unsent-typed-ansi.txt: the box as the pane drew it for "Fix the" — both rules are
    // unbroken runs of ─ from the pane's first column, and the closing one is the window's
    // last rule row, the footers under it.
    expect(boxHoldsText('claude-code', 'Fix the', fixture('unsent-typed-ansi'))).toBe(true);
  });

  test('a rule-looking row after the wrapped text gets no Enter', async () => {
    // The round-5 reproduction: the box shows the two text rows, then one more indented row
    // of forty ─ before its closing rule. The pane draws content rows at the text's own
    // column, and the box's closing rule is the window's last rule row — an unbroken run from
    // the pane's first column, the opening rule's own width. The extra row is neither, so the
    // box is not the typed text.
    const typed = 'alpha beta\ngamma delta';
    const screen = claudeBox([...typed.split('\n'), ROGUE].join('\n'));
    expect(boxHoldsText('claude-code', typed, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('claude-code', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('a rule-looking row between two text rows gets no Enter', async () => {
    // The box shows the typed row, then a rule-looking row, then another text row. However the
    // row under the rule-looking one reads, that row is content the typed text does not have.
    const typed = 'alpha beta';
    const screen = claudeBox([typed, ROGUE, 'gamma delta'].join('\n'));
    expect(boxHoldsText('claude-code', typed, screen)).toBe(false);
    // The text that owns both text rows is not this box either: the row between them is not
    // the text's own.
    expect(boxHoldsText('claude-code', 'alpha beta\ngamma delta', screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('claude-code', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('a typed text whose own row is the rule shape is the box and is entered', async () => {
    // The pane draws the second line at the content column — two spaces, the prompt row's own
    // width — and a rule-looking row there is content, told from the box's closing rule by its
    // column (unsent-typed-ansi.txt: both rules start at the pane's first column). The box
    // holds the text, so the Enter is the delivery's.
    const typed = `alpha beta\n${ROGUE}`;
    const screen = claudeBox(typed);
    expect(boxHoldsText('claude-code', typed, screen)).toBe(true);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('claude-code', typed, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([typed, 'Enter']);
  });

  test('a box holding a person\'s own text gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(claudeBox('Other rules.')); return true; };
    expect(await deliverRules('claude-code', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
});
