import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { classify, classifyComposer, readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { boxHoldsText, deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { wordWrap } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

const codex = profileFor('codex');
if (!codex) throw new Error('codex has no profile');

describe('Codex launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.')).toBe('AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-daemon --no-alt-screen');
    expect(codex.rulesOption).toBeNull();
    expect(codex.loginCheck).toEqual(['login', 'status']);
    expect(codex.exit).toBe('/exit');
    expect(versionVerdict('codex-cli 0.157.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.160.0', codex.tested)).toBe('newer');
  });
  test.each([
    ['idle', 'idle'], ['unsent', 'unsent'], ['working', 'working'],
    ['rules-accepted', 'idle'], ['startup', 'question'], ['startup-loading', 'unknown'], ['trust', 'trust'],
    ['exit-typed', 'unsent'], ['exit', 'unknown'], ['permission', 'permission'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('codex', fixture(file)).kind).toBe(kind);
  });
  test('a permission dialog above the pinned status line is the dialog, not unsent text', () => {
    // `permission-pinned` is constructed, not captured: the captured dialog with the captured
    // status line below it (see the fixtures README). Read before the fix: `unsent` — the
    // composer took the choice line for an input prompt, and the floor's markers missed the
    // dialog's lower-case `esc to cancel` below it.
    const pinned = fixture('permission-pinned');
    expect(classify('codex', pinned.split('\n')).kind).toBe('permission');
    expect(readScreen('codex', pinned).kind).toBe('permission');
    // The composer alone never says idle or unsent on the dialog either: `deliverRules` waits
    // on that reading after the paste.
    expect(classifyComposer('codex', pinned.split('\n')).kind).toBe('unknown');
  });
  test('a trust dialog with a running turn beside it is still trust, not working', () => {
    // The turn's own status line stays on the pane while the dialog is up: the dialog shape is
    // read first, as for claude-code.
    const screen = fixture('trust').replace(
      '› 1. Trust and continue',
      '• Working (0s • esc to interrupt)\n\n› 1. Trust and continue',
    );
    expect(readScreen('codex', screen).kind).toBe('trust');
  });
  test('permission takes precedence over a running turn and requires an active footer', () => {
    const captured = fixture('permission');
    const working = captured.replace('› 1. Yes', '• Working (0s • esc to interrupt)\n\n› 1. Yes');
    expect(readScreen('codex', working).kind).toBe('permission');
    expect(readScreen('codex', captured + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('codex', captured.replace('Press enter to confirm or esc to cancel', '')).kind).toBe('unknown');
  });
  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [undefined, '❯\n', '›\n', 'Welcome to Codex\nSign in to continue', 'Do you allow this command?\n› 1. Yes\nEnter to confirm']) {
      expect(readScreen('codex', screen).kind).toBe('unknown');
    }
    expect(readScreen('codex', fixture('idle').replace('GPT-5.6-Terra medium ·', 'new footer')).kind).toBe('unknown');
  });
  test('a quoted trust dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('codex', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('codex', fixture('idle').replace('› Ask Codex to do anything', '›\n  unsent second line')).kind).toBe('unsent');
  });
  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(codex.modelOf('codex -m gpt-6-sol -c model_reasoning_effort=high')).toEqual({ model: 'GPT Sol', version: '6' });
    expect(codex.modelOf('codex --model=gpt-5.6-terra')).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(codex.modelOf('codex -m gpt-6-sol -m gpt-5.6-terra')).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(codex.modelOf('codex -m unknown')).toBeNull();
    expect(codex.modelOf('launcher')).toBeNull();
    expect(runningModel('codex', fixture('idle'))).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(runningModel('codex', fixture('trust'))).toBeNull();
  });
  test('the plan delivers through the guarded first-message path, never a config file', () => {
    const plan = upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true,
      seats: [{ name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.' }] });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({ do: 'deliver', cli: 'codex', rules: 'Rules.', seconds: 90 });
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });
});

/** The captured idle frame once `text` sits in the box: the placeholder row replaced, the text's
 *  first line after the prompt, every later line at the column the captures draw continuation
 *  rows in — two columns, the prompt's own width (see the fixtures README). */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('› Ask Codex to do anything', body);
}

// The rules message the real capture holds, as team composed it: its lines sat at column zero,
// and Codex drew each later line through its own prompt column (see the fixtures README).
const CAPTURED_MESSAGE = [
  'Rules for this session, from the team file:',
  '- Do not use tools or edit files.',
  '- Do not change trust or configuration.',
  '- Reply only RULES_RECEIVED, then wait.',
].join('\n');

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const io: Delivery = {
    screen: () => raw, status: () => status,
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['codex'],
    now: () => clock, sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Codex rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });
  test('the captured box reads back as the typed message and is entered', async () => {
    // The real capture, with the message as team composed it: the box's own rows are the typed
    // lines, so the Enter is the delivery's to send.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('codex', CAPTURED_MESSAGE, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([CAPTURED_MESSAGE, 'Enter']);
  });
  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a different first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a box whose rows are the typed line word-wrapped on the pane is entered', async () => {
    // No Codex capture shows its composer wrapping a line, so no wrap is modelled for it: the
    // box rows must read back as the typed line laid out in order — the words that fit, the rest
    // continued at the prompt row's two columns — and then the Enter is the paste's.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    expect(rows.length).toBeGreaterThan(1);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(rows.join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([line, 'Enter']);
  });
  test('a word-wrapped box with one character changed gets no Enter', async () => {
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const changed = line.replace('signature', 'signatvre');
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(wordWrap(changed, 53 - 2).join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('a word-wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of the wrapped line: the pane draws one only where
    // the text itself has a blank line, and this line has none.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed([firstRow, '', ...rest].join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('a blank line the typed text itself has is entered', async () => {
    const typed = 'Rules.\n\nMore rules.';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('codex', typed, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([typed, 'Enter']);
  });
  test('two spaces typed, one shown, gets no Enter', async () => {
    // The shared read refuses a box that shows a single space where the typed text has two: the
    // wrap did not add or drop it. Every profile without a captured wrap reads the same way.
    expect(boxHoldsText('codex', 'alpha  beta', boxed('alpha beta'))).toBe(false);
  });
  test.each(['permission', 'trust', 'startup', 'unsent', 'exit', 'working'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working'); d.status('idle');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
  test.each(['trust', 'permission'])('a %s dialog appearing after paste gets no Enter', async (dialog) => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show(dialog); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test.each(['trust', 'permission'])('a %s dialog arriving at the final re-read gets no Enter', async (dialog) => {
    const d = delivery(); let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? dialog : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a permission dialog above the pinned status line appearing after paste gets no Enter', async () => {
    // Read before the fix: the dialog was `unsent` to both re-reads below, so the paste looked
    // submitted and the Enter went to the dialog's first choice.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('permission-pinned'); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a permission dialog above the pinned status line arriving at the final re-read gets no Enter', async () => {
    const d = delivery(); let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'permission-pinned' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    }
  });
  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery(); let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
  });
});
