import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { classify, classifyComposer, readBox, readFold, readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { boxHoldsText, deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { NUDGE_TEXT } from '../../src/watch/pass.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { wordWrap } from '../helpers.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/cursor/2026.10.01/${name}.txt`, import.meta.url), 'utf8');

const cursor = profileFor('cursor');
if (!cursor) throw new Error('cursor has no profile');

describe('Cursor launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(profileFor('cursor')).toBe(cursor);
    expect(launchCommand(cursor, 'cursor-agent', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --force --sandbox disabled',
    );
    expect(launchCommand(cursor, 'cursor-agent --model grok-4.7-high', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 cursor-agent --model grok-4.7-high --force --sandbox disabled',
    );
    expect(cursor.rulesOption).toBeNull();
    expect(cursor.loginCheck).toEqual(['status']);
    expect(cursor.loginHint).toBe('cursor-agent login');
    expect(cursor.exit).toBe('/exit');
    expect(cursor.unattended).not.toContain('--trust');
    expect(versionVerdict('2026.10.01-14929f9', cursor.tested)).toBe('tested');
    expect(versionVerdict('2026.10.02', cursor.tested)).toBe('newer');
    expect(versionVerdict('2026.09.30', cursor.tested)).toBe('older');
  });

  test.each([
    ['startup', 'idle'],
    ['idle', 'idle'],
    ['unsent', 'unsent'],
    ['working', 'working'],
    ['thinking', 'working'],
    ['rules-accepted', 'idle'],
    ['trust', 'trust'],
    ['exit-typed', 'unsent'],
    ['exit', 'unknown'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('cursor', fixture(file)).kind).toBe(kind);
  });

  test('a trust dialog with a running turn beside it is still trust, not working', () => {
    const screen = fixture('trust').replace(
      '│  ▶ [a] Trust this workspace',
      ' ⠀⠞ Working\n\n│  ▶ [a] Trust this workspace',
    );
    expect(readScreen('cursor', screen).kind).toBe('trust');
  });

  test('a finished turn reads idle', () => {
    expect(readScreen('cursor', fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('idle')).kind).toBe('idle');
  });

  test('the composer alone reads a resume line as unknown', async () => {
    const lines = fixture('exit').split('\n');
    expect(readScreen('cursor', fixture('exit')).kind).toBe('unknown');
    expect(classifyComposer('cursor', lines).kind).toBe('unknown');
    const exit = delivery('exit');
    expect(await deliverRules('cursor', 'Rules.', 1, exit.io)).toBe(false);
    expect(exit.calls).toEqual([]);
    expect(readScreen('cursor', fixture('trust')).kind).toBe('trust');
    const trust = delivery('trust');
    expect(await deliverRules('cursor', 'Rules.', 1, trust.io)).toBe(false);
    expect(trust.calls).toEqual([]);
  });

  test('a floor phrase above the composer leaves a typed exit unsent', () => {
    const lines = fixture('exit-typed').split('\n');
    const prompt = lines.findIndex((line) => /^\s*→\s+\S/.test(line));
    const above = [...lines.slice(0, prompt), 'Do you want to proceed?', ...lines.slice(prompt)].join('\n');
    const inside = [...lines.slice(0, prompt + 1), 'Do you want to proceed?', ...lines.slice(prompt + 1)].join('\n');
    expect(readScreen('cursor', fixture('exit-typed')).kind).toBe('unsent');
    expect(readScreen('cursor', above).kind).toBe('unsent');
    expect(classifyComposer('cursor', above.split('\n')).kind).toBe('unsent');
    expect(readScreen('cursor', inside).kind).toBe('unknown');
  });

  test('a working turn still has an empty composer, which is what delivery waits for', () => {
    const lines = fixture('working').split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(readScreen('cursor', fixture('working')).kind).toBe('working');
    expect(classifyComposer('cursor', lines).kind).toBe('idle');
    const thinking = fixture('thinking').split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(classifyComposer('cursor', thinking).kind).toBe('idle');
  });

  test.each([
    ['follow-up-queue-two', 'working'],
    ['follow-up-queue-hint', 'working'],
    ['follow-up-queue-one', 'working'],
  ] as const)('%s: a follow-up queue under a running turn reads %s', (file, kind) => {
    // Nobody typed: the queue's rows are not input text, and the composer's own
    // row is the placeholder — an empty box — so the turn's reading stands.
    expect(readScreen('cursor', fixture(file)).kind).toBe(kind);
    const lines = fixture(file).split('\n');
    expect(classify('cursor', lines).kind).toBe(kind);
    expect(classifyComposer('cursor', lines).kind).toBe('idle');
  });

  test('typed text still reads unsent, with and without a queue box above it', () => {
    expect(readScreen('cursor', fixture('unsent')).kind).toBe('unsent');
    // With a queue box above it the text is still the composer's own, not the
    // queue's: the composer read says unsent, and the painted spinner — the
    // running turn — is what makes the whole screen working.
    const withQueue = fixture('follow-up-queue-typed').split('\n');
    expect(classifyComposer('cursor', withQueue).kind).toBe('unsent');
    expect(readScreen('cursor', fixture('follow-up-queue-typed')).kind).toBe('working');
    // Take the turn's paint away and the text decides, exactly as without the box.
    const quiet = withQueue.filter((line) => !/^\s*[⠀-⣿]/.test(line)).join('\n');
    expect(readScreen('cursor', quiet).kind).toBe('unsent');
    expect(classifyComposer('cursor', quiet.split('\n')).kind).toBe('unsent');
  });

  test('a queue box with no running turn under it is working, never idle', () => {
    // No spinner row and no `ctrl+c to stop`: the box is what is left of the
    // turn, and its messages are still waiting on one. Working means nothing is
    // typed into it and `down --wait` waits; idle would end the seat.
    const quiet = fixture('follow-up-queue-two')
      .split('\n')
      .map((line) => line.replace(/\s{2,}ctrl\+c to stop\s*$/, ''))
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .join('\n');
    expect(readScreen('cursor', quiet).kind).toBe('working');
    expect(classifyComposer('cursor', quiet.split('\n')).kind).toBe('idle');
  });

  test('a typed row below a queue box is unsent, not a running turn', () => {
    // No spinner and no `ctrl+c to stop`, an empty composer row and the
    // placeholder row, then a typed row below both: only the box's row above the
    // composer is what says a queue frame, so a typed row under the box must
    // defeat the rule. The earlier rule took the rows in either order and
    // dropped every `→` row from the after-check, so this read working.
    const frame = fixture('follow-up-queue-one')
      .split('\n')
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .map((line) => line.replace(/^(\s*)→\s*Add a follow-up\s*$/, '$1→\n$1→ Add a follow-up\n$1→ Reply with exactly RULES_RECEIVED. Do not use'))
      .join('\n');
    expect(readScreen('cursor', frame).kind).toBe('unsent');
    expect(classifyComposer('cursor', frame.split('\n')).kind).toBe('unsent');
  });

  test('prose that looks like the queue box leaves an idle prompt idle', () => {
    const idleLines = fixture('idle').split('\n');
    const at = idleLines.findIndex((line) => /^\s*→/.test(line));
    expect(at).toBeGreaterThan(0);
    const boxTop = '  ┌─ follow-ups ────────────────────────┐';
    const boxRow = '  │ ○ First queued message.              │';
    const boxEnd = '  └──────────────────────────────────────┘';
    const hintRow = '  │ enter steer · ↑ select/edit · esc cancel │';
    const quoted = [...idleLines.slice(0, at), boxTop, boxRow, boxEnd, '  the box lists the messages already sent.', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', quoted).kind).toBe('idle');
    // Even a paste that reproduces the overlay's own hint line leaves idle when
    // more prose follows it: the box is then not directly above the prompt area.
    const pasted = [...idleLines.slice(0, at), boxTop, boxRow, hintRow, boxEnd, '  and nothing had been typed.', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', pasted).kind).toBe('idle');
    expect(classifyComposer('cursor', pasted.split('\n')).kind).toBe('idle');
  });

  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [
      undefined,
      '❯\n',
      '→\n',
      'Welcome to Cursor\nSign in to continue',
      'Do you allow this command?\n→ 1. Yes\nEnter to confirm',
      'Do you trust the contents of this directory?\n',
    ]) {
      expect(readScreen('cursor', screen).kind).toBe('unknown');
    }
    expect(readScreen('cursor', fixture('idle').replace('Grok 4.7 256K High', 'new footer')).kind).toBe('unknown');
  });

  test('a quoted trust dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('cursor', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    const wrapped = fixture('idle').replace('→ Plan, search, build anything', '→\n  unsent second line');
    expect(readScreen('cursor', wrapped).kind).toBe('unsent');
  });

  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(cursor.modelOf('cursor-agent --model grok-4.7-high')).toEqual({ model: 'Grok', version: '4.7' });
    expect(cursor.modelOf('cursor-agent --model=grok-4.7-xhigh-fast')).toEqual({ model: 'Grok', version: '4.7' });
    expect(cursor.modelOf('cursor-agent --model cursor-grok-4.5-high')).toEqual({ model: 'Grok', version: '4.5' });
    expect(cursor.modelOf('cursor-agent --model grok-4.7-high[context=256k]')).toBeNull();
    expect(cursor.modelOf('cursor-agent --model gpt-5')).toBeNull();
    expect(cursor.modelOf('cursor-agent')).toBeNull();
    expect(cursor.modelOf('cursor-agent --model cursor-grok-4.6-high-fast')).toEqual({ model: 'Grok', version: '4.6' });
    expect(cursor.modelOf('cursor-agent --model grok-4.7')).toEqual({ model: 'Grok', version: '4.7' });
    expect(cursor.modelOf('cursor-agent --model grok-4.7 --model grok-4.5')).toEqual({ model: 'Grok', version: '4.5' });
    expect(runningModel('cursor', fixture('idle'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('cursor', fixture('rules-accepted'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('cursor', fixture('trust'))).toBeNull();
    expect(runningModel('cursor', fixture('exit'))).toBeNull();
  });

  test('the plan delivers through the guarded first-message path, never a config file', () => {
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      seats: [{
        name: 'grok',
        cli: 'cursor',
        launch: 'cursor-agent',
        cwd: '.',
        label: 'grok',
        stopped: false,
        rules: 'Rules.',
      }],
    });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({
      do: 'deliver',
      cli: 'cursor',
      rules: 'Rules.',
      seconds: 90,
    });
    const launched = plan.find((step) => step.kind === 'run' && step.do?.do === 'launch');
    const command = launched?.kind === 'run' ? launched.argv.join(' ') : '';
    expect(command).toContain('cursor-agent --force --sandbox disabled');
    expect(command).not.toContain('--trust');
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });
});

/** The captured idle frame once `lines` sit in the box: the placeholder row replaced, the first
 *  line after the prompt, every later line at the column the captured wrap draws continuation
 *  rows in — four columns, the prompt row's own width (see the fixtures README). */
function box(lines: string[]): string {
  const [first = '', ...rest] = lines;
  const body = [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
  return fixture('idle').replace('  → Plan, search, build anything', body);
}

function boxed(text: string): string {
  return box(text.split('\n'));
}

/** The pane's own wrap, as the captured `unsent.txt` shows it: a line wider than the pane's
 *  content column breaks at a space, the words that fit on the row and the rest continued at the
 *  text column (the pane is the prompt row's four columns plus its content). */
function wrapped(text: string, pane: number): string {
  return box(wordWrap(text, pane - 4));
}

// The rules message the real capture holds, as team composed it: the 80-character sentence
// Cursor wrapped over two rows on its 51-column pane (see the fixtures README).
const CAPTURED_WRAP = 'Reply with exactly RULES_RECEIVED. Do not use tools. Do not read or write files.';

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' || initial === 'thinking' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['cursor-agent'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Cursor rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('the captured wrapped paste reads back through the profile\'s wrap and is entered', async () => {
    // unsent.txt is this sentence word-wrapped on the pane's 51 columns: the words that fit on
    // the first row (45 characters; the next word would not), the rest continued at the text
    // column. The profile's wrap rule joins the rows back into the typed line, so the box is
    // observed to hold the paste and its Enter is sent.
    const message = CAPTURED_WRAP;
    const capture = fixture('unsent');
    expect(readFold('cursor', capture)).toBeNull();
    expect(readScreen('cursor', capture).kind).toBe('unsent');
    // The capture is this very wrap: its box rows are the model's, joined back to the sentence.
    const box = readBox('cursor', capture);
    if (!box) throw new Error('the capture has no box');
    const rows = wordWrap(message, 51 - 4);
    expect([box.first, ...box.rows.map((row) => row.trim())]).toEqual(rows);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('cursor', message, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([message, 'Enter']);
  });

  test.each([40, 51, 80])('the rules sentence wrapped on a %s-column pane still gets its Enter', async (pane) => {
    // Wider and narrower panes wrap the same sentence over more or fewer rows; the wrap rule
    // joins them all, and every pane that shows the whole sentence gets the Enter.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(wrapped(text, pane)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([CAPTURED_WRAP, 'Enter']);
  });

  test('the nudge, wrapped on the same pane, reads back and is entered', async () => {
    // The watch's nudge and the exit typing share this gate (`boxHoldsText`). On the 51-column
    // pane Cursor wraps the nudge exactly as it wrapped the rules sentence; a box holding
    // something else is still refused.
    expect(boxHoldsText('cursor', NUDGE_TEXT, wrapped(NUDGE_TEXT, 51))).toBe(true);
    const person = 'Someone else wrote this line and it is not the nudge';
    expect(boxHoldsText('cursor', NUDGE_TEXT, wrapped(person, 51))).toBe(false);
  });

  test('a wrapped box holding a person\'s own text gets no Enter', async () => {
    // The same wrap, a different sentence: joined it is not the typed text.
    const d = delivery();
    const person = 'Someone else wrote this sentence on the pane and its words are not ours.';
    d.io.type = (text) => { d.calls.push(text); d.showText(wrapped(person, 51)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a wrapped box with one character changed gets no Enter', async () => {
    const d = delivery();
    const changed = CAPTURED_WRAP.replace('RULES_RECEIVED', 'RULES_RECEIVFD');
    d.io.type = (text) => { d.calls.push(text); d.showText(wrapped(changed, 51)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a wrapped box with an extra row below it gets no Enter', async () => {
    const d = delivery();
    const extra = [...wordWrap(CAPTURED_WRAP, 51 - 4), 'and a line of their own'];
    d.io.type = (text) => { d.calls.push(text); d.showText(box(extra)); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of a wrapped text: the pane draws one only where
    // the text itself has a blank line, and this sentence has none.
    const rows = wordWrap(CAPTURED_WRAP, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(box([firstRow, '', ...rest])); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('the nudge wrapped with a blank row gets no Enter', async () => {
    // The nudge and the exit gate on the same read: a blank row the nudge does not have.
    const rows = wordWrap(NUDGE_TEXT, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    expect(boxHoldsText('cursor', NUDGE_TEXT, box([firstRow, '', ...rest]))).toBe(false);
  });

  test('a blank row the typed text itself has is entered', async () => {
    // The one place a blank row is the text's own: the typed text has that blank line there.
    const typed = 'alpha beta\n\ngamma delta';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([typed, 'Enter']);
  });

  test('two spaces typed, one shown, gets no Enter — the delivery path and the gate', async () => {
    // The typed text has a run of two spaces; the box shows one. The wrap did not add or drop
    // that space, so the box is not the typed text, and nothing presses Enter on it. The watch's
    // nudge and the typed exit gate on the same read.
    const typed = 'alpha  beta';
    expect(boxHoldsText('cursor', typed, box(['alpha beta']))).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(box(['alpha beta'])); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('the same collapse inside a wrapped row gets no Enter', async () => {
    // Only a row break may stand for whitespace at a wrap boundary; inside a row the characters
    // must match the typed text exactly, runs of spaces included.
    const typed = 'alpha  beta gamma delta epsilon';
    const collapsed = wordWrap(typed, 20).map((row) => row.replace('  ', ' '));
    expect(boxHoldsText('cursor', typed, box(collapsed))).toBe(false);
  });

  test('two spaces shown as two are the text and are entered', async () => {
    const typed = 'alpha  beta';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(box(['alpha  beta'])); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([typed, 'Enter']);
  });

  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a shorter first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a boxed multi-line paste reads back row for row and is entered', async () => {
    const d = delivery();
    expect(await deliverRules('cursor', 'Rules.\nOne more line.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.\nOne more line.', 'Enter']);
  });

  test('the typed exit read back from the captured completion frame is entered', async () => {
    // exit-typed.txt: `/exit` in the box with the suggestion menu below it. The box's own row
    // is the typed text, so the exit's Enter may be sent.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('exit-typed'); return true; };
    expect(await deliverRules('cursor', '/exit', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['/exit', 'Enter']);
  });

  test.each(['trust', 'unsent', 'exit', 'working', 'thinking'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working');
    d.status('idle');
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a trust question appearing after paste gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('trust'); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a dialog arriving at the final re-read gets no Enter', async () => {
    const d = delivery();
    let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'trust' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    }
  });

  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery();
    let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
  });
});
