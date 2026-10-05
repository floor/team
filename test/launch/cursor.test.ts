import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, statusOnLine, versionVerdict } from '../../src/profiles/profile.ts';
import { classify, classifyComposer, readBox, readFold, readScreen, screenData } from '../../src/watch/screen.ts';
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

  test('dialog phrases in a transcript or a typed box are not the dialog', () => {
    const idle = fixture('idle');
    const unsent = fixture('unsent');
    const question = fixture('question');
    const plan = 'Approve mode switch (y)\nReject (n or esc)\n';
    const choice = 'Space select\nEsc to skip\n';
    const typed = (screen: string, words: string) => {
      const [first, ...rest] = words.trimEnd().split('\n');
      return screen.replace('  → Plan, search, build anything', `  → ${first}\n    ${rest.join('\n    ')}`);
    };
    expect(readScreen('cursor', plan + idle).kind).toBe('idle');
    expect(readScreen('cursor', plan + unsent).kind).toBe('unsent');
    expect(readScreen('cursor', typed(idle, plan)).kind).toBe('unsent');
    expect(readScreen('cursor', question.replace(
      '│ Choose a filename',
      '│ Approve mode switch (y)\n│ Reject (n or esc)\n│ Choose a filename',
    )).kind).toBe('question');
    expect(readScreen('cursor', choice + idle).kind).toBe('idle');
    expect(readScreen('cursor', choice + unsent).kind).toBe('unsent');
    expect(readScreen('cursor', typed(idle, choice)).kind).toBe('unsent');
    expect(readScreen('cursor', fixture('permission-plan')).kind).toBe('permission');
    expect(readScreen('cursor', question).kind).toBe('question');
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

  test('a typed row below a queue box is unknown, never a running turn and never typed into', () => {
    // No spinner and no `ctrl+c to stop`, an empty composer row and the
    // placeholder row, then a typed row below both: only the box's row above the
    // composer is what says a queue frame, so a typed row under the box must
    // defeat the rule. The earlier rule took the rows in either order and
    // dropped every `→` row from the after-check, so this read working.
    //
    // Three rows at the prompt column in one box is a shape no capture draws:
    // Cursor indents every row of a person's text to the content column. Since
    // 0.2.1 the box fails closed on it — the input row is the box's first prompt
    // row, and a later row still at the prompt column is neither text nor frame —
    // so it reads unknown, never working, and nothing is typed into it or sent.
    const frame = fixture('follow-up-queue-one')
      .split('\n')
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .map((line) => line.replace(/^(\s*)→\s*Add a follow-up\s*$/, '$1→\n$1→ Add a follow-up\n$1→ Reply with exactly RULES_RECEIVED. Do not use'))
      .join('\n');
    expect(readScreen('cursor', frame).kind).toBe('unknown');
    expect(classifyComposer('cursor', frame.split('\n')).kind).toBe('unknown');
  });

  test('prose that looks like the queue box leaves an idle prompt idle', () => {
    const idleLines = fixture('idle').split('\n');
    const at = idleLines.findIndex((line) => /^\s*→/.test(line));
    expect(at).toBeGreaterThan(0);
    const boxTop = '  ┌─ follow-ups ────────────────────────┐';
    const boxRow = '  │ ○ First queued message.              │';
    const boxEnd = '  └──────────────────────────────────────┘';
    const hintRow = '  │ enter steer · ↑ select/edit · esc cancel │';
    // The lookalike sits in the transcript, above the blank frame rows every capture draws
    // against the input row (idle.txt's rows 5-8): it is then read as nothing.
    const quoted = [...idleLines.slice(0, at), boxTop, boxRow, boxEnd, '  the box lists the messages already sent.', '', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', quoted).kind).toBe('idle');
    // Even a paste that reproduces the overlay's own hint line leaves idle when
    // more prose follows it: the box is then not directly above the prompt area.
    const pasted = [...idleLines.slice(0, at), boxTop, boxRow, hintRow, boxEnd, '  and nothing had been typed.', '', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', pasted).kind).toBe('idle');
    expect(classifyComposer('cursor', pasted.split('\n')).kind).toBe('idle');
    // Pressed against the prompt with no frame row between, the same prose is a shape no
    // capture draws — the transcript's last row sits above the gap, never against the
    // prompt — so the read fails closed rather than take the prompt for an input row.
    const against = [...idleLines.slice(0, at), boxTop, boxRow, boxEnd, '  the box lists the messages already sent.', ...idleLines.slice(at)].join('\n');
    expect(readScreen('cursor', against).kind).toBe('unknown');
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
    expect(cursor.modelOf('cursor-agent --model gpt-5.6-sol-high')).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(cursor.modelOf('cursor-agent --model gemini-3.8-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(cursor.modelOf('cursor-agent --model composer-2.5')).toEqual({ model: 'Composer', version: '2.5' });
    expect(cursor.modelOf('cursor-agent --model gpt-5.2')).toBeNull();
    expect(cursor.modelFlag('Grok', '4.7')).toEqual({ option: '--model', id: 'grok-4.7-high' });
    expect(cursor.modelFlag('GPT Sol', '5.6')).toEqual({ option: '--model', id: 'gpt-5.6-sol-high' });
    expect(cursor.modelFlag('Gemini Flash', '3.8')).toEqual({ option: '--model', id: 'gemini-3.8-flash-high' });
    expect(cursor.modelFlag('Composer', '2.5')).toEqual({ option: '--model', id: 'composer-2.5' });
    expect(cursor.modelFlag('Grok', '4.5')).toEqual({ option: '--model', id: null });
    expect(cursor.startsOnLastModel).toBe(true);
  });

  test('the home and a typed line are read under other model families', () => {
    expect(readScreen('cursor', fixture('gpt-sol-idle')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('gpt-sol-unsent')).kind).toBe('unsent');
    expect(runningModel('cursor', fixture('gpt-sol-idle'))).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(runningModel('cursor', fixture('gpt-sol-unsent'))).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(readScreen('cursor', fixture('gemini-flash-idle')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('gemini-flash-unsent')).kind).toBe('unsent');
    expect(runningModel('cursor', fixture('gemini-flash-idle'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(runningModel('cursor', fixture('gemini-flash-unsent'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(readScreen('cursor', fixture('composer-idle')).kind).toBe('idle');
    expect(readScreen('cursor', fixture('composer-unsent')).kind).toBe('unsent');
    expect(runningModel('cursor', fixture('composer-idle'))).toEqual({ model: 'Composer', version: '2.5' });
    expect(runningModel('cursor', fixture('composer-unsent'))).toEqual({ model: 'Composer', version: '2.5' });
    const swapped = fixture('idle').replace('Grok 4.7 256K High', 'GPT-5.6 Sol 272K High');
    expect(readScreen('cursor', swapped).kind).toBe('idle');
    expect(runningModel('cursor', swapped)).toEqual({ model: 'GPT Sol', version: '5.6' });
  });

  test('a line of output that names a model is not a status row', () => {
    const prose = fixture('idle').replace(
      '  Grok 4.7 256K High                 Run Everything',
      '  the agent wrote that GPT-5.6 Sol is ready',
    );
    expect(readScreen('cursor', prose).kind).toBe('unknown');
    expect(runningModel('cursor', prose)).toBeNull();
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

/** The bordered idle frame once `lines` sit in the box: the placeholder row replaced, the first
 *  line after the prompt, every later line at the captured continuation column — the bordered
 *  captures' own shape (bordered-typed-three.txt) — with the border rows left where the capture
 *  draws them. */
function borderedBox(lines: string[]): string {
  const [first = '', ...rest] = lines;
  const body = [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
  return fixture('bordered-idle').replace('  → Plan, search, build anything', body);
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

  test('a trailing blank row after the wrapped text gets no Enter', async () => {
    // The probe: the correctly wrapped text, then one more empty row inside the box. Cursor
    // draws two empty rows of its own under the text — idle.txt and unsent.txt show them, the
    // drop before the status line — and those rows are the box's frame, not its content. A row
    // beyond them is a row the text does not have: someone pressed a newline after it.
    const rows = wordWrap(CAPTURED_WRAP, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    const body = [`  → ${firstRow}`, ...rest.map((row) => `    ${row}`), ''].join('\n');
    const screen = fixture('idle').replace('  → Plan, search, build anything', body);
    expect(boxHoldsText('cursor', CAPTURED_WRAP, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('cursor', CAPTURED_WRAP, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_WRAP]);
  });

  test('a typed text whose own last line is empty: the box shows the row, or no Enter', async () => {
    // The text ends with a newline, so its last line is empty and the pane draws a row for it,
    // above the two frame rows it draws under every box. That screen and the one with the extra
    // blank row are the same layout: only the typed text tells them apart. With the row the box
    // holds the text; without it the box stops at the sentence and the trailing newline is
    // unaccounted for.
    const typed = CAPTURED_WRAP + '\n';
    const rows = wordWrap(CAPTURED_WRAP, 51 - 4);
    const [firstRow = '', ...rest] = rows;
    const body = [`  → ${firstRow}`, ...rest.map((row) => `    ${row}`)];
    const withRow = fixture('idle').replace('  → Plan, search, build anything', [...body, ''].join('\n'));
    const withoutRow = fixture('idle').replace('  → Plan, search, build anything', body.join('\n'));
    expect(boxHoldsText('cursor', typed, withRow)).toBe(true);
    expect(boxHoldsText('cursor', typed, withoutRow)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(withoutRow); return true; };
    expect(await deliverRules('cursor', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
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

describe('the prompt-glyph continuation row (Cursor)', () => {
  // The person's box holds their own text, then a continuation row at the text column carrying
  // only the prompt glyph. The input row is the row carrying the prompt at the captures' own
  // column — unsent.txt draws `→` at the pane's second column and continuations at the fourth
  // — never the last row whose content begins with a glyph.
  const GLYPH = '→';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('cursor', boxed(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `→ Rules.`.
    expect(boxHoldsText('cursor', 'Rules.', boxed(`person text\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(boxed(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a glyph row with text after it and two glyph rows all leave the text above them in the box', () => {
    expect(boxHoldsText('cursor', 'quoted', boxed(`person text\n${GLYPH} quoted`))).toBe(false);
    expect(readScreen('cursor', boxed(`person text\n${GLYPH}\n${GLYPH}`)).kind).toBe('unsent');
    expect(boxHoldsText('cursor', 'Rules.', boxed(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a second glyph row at the prompt column fails closed: never idle, never entered', async () => {
    // The Cursor twin of the Codex boundary: the person's text on the input row and a second
    // row carrying `→` at that same column (the pane's second, where the captures draw the
    // input). The captures show the CLI continuing a person's line at the fourth column in
    // every case — including a second line that itself begins with `→`
    // (typed-glyph-second.txt) — so a person's glyph at the prompt column is a shape no
    // capture explains, and the read is `unknown`: nothing is typed into it and no Enter is
    // sent. Read by its lowest row the box was idle, the paste went after the second glyph,
    // the read-back held only the typed text, and the Enter submitted both.
    const at = (typed = '') => fixture('idle')
      .replace('  → Plan, search, build anything', `  → person text\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('unknown');
    expect(classify('cursor', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('the box\'s top frame (Cursor)', () => {
  // The Cursor twin of the Codex frame: every capture draws blank rows directly above the
  // input row — four in idle.txt (rows 5-8 above the input at 9), unsent.txt and the typed
  // captures alike — and above them the transcript's or the pane's last row
  // (idle.txt's `  hints.`, rules-accepted.txt's `  RULES_RECEIVED`, the queue fixtures'
  // spinner). typed-blank-middle.txt draws a blank row inside a person's box as its third
  // line at the content column (four), never at the prompt column (two): a second glyph at
  // the prompt column after a blank is the transcript's echo of a sent message — working.txt
  // and rules-accepted.txt draw sent text at the content column without the glyph,
  // follow-up-queue-typed.txt shows the glyph only on queued text — not a row of a person's
  // box, so the empty input row under the frame reads `idle`, exactly as main reads it. No
  // shipped capture shows the direct echo layout; the constructed screens below stand in.
  const shaped = (body: string) => fixture('idle').replace('  → Plan, search, build anything', body);

  test('the transcript\'s echo over the gap leaves the empty box idle, and the typed text reads back exactly', async () => {
    // The routine post-send layout, settled by typed-blank-middle.txt: the person's sent
    // message echoed at the prompt column, the captured blank frame, the empty input row. It
    // reads `idle` on every reader and rules delivery types and enters; the read-back holds
    // exactly the typed text.
    const at = (typed = '') => shaped(`  → person text\n\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('idle');
    expect(classify('cursor', at().split('\n')).kind).toBe('idle');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('idle');
    expect(readScreen('cursor', at('Rules.')).kind).toBe('unsent');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(true);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('two and three blank rows above the input read the same', () => {
    for (const gap of ['\n\n\n', '\n\n\n\n']) {
      expect(readScreen('cursor', shaped(`  → person text${gap}  →`)).kind).toBe('idle');
    }
  });

  test('agent output between the echo and the frame reads idle', () => {
    // rules-accepted.txt in full: the sent text at the content column, `  RULES_RECEIVED` and
    // the timestamp between it and the frame, the empty input row last. The real capture, read
    // as it always was, with the new rule taking nothing from it.
    expect(readScreen('cursor', fixture('rules-accepted')).kind).toBe('idle');
  });

  test('a second prompt row pressed against the one above it fails closed', async () => {
    // Cursor's twin of the pressed-row rule, unchanged: no blank row separates the person's
    // row from the later prompt, so the row above the lowest prompt is not the frame and the
    // input row cannot be shown to be the box's top. Nothing is typed and Enter is not sent.
    const at = (typed = '') => shaped(`  → person text\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('unknown');
    expect(classify('cursor', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a blank row, a continuation row, then a prompt fails closed', () => {
    const at = shaped('  → person text\n\n    more of theirs\n  →');
    expect(readScreen('cursor', at).kind).toBe('unknown');
    expect(classifyComposer('cursor', at.split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', shaped('  → person text\n\n    more of theirs\n  → Rules.'))).toBe(false);
  });

  test('a window starting inside the box fails closed', async () => {
    const at = (typed = '') => shaped(`    person-owned visible continuation\n  →${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('cursor', at()).kind).toBe('unknown');
    expect(classify('cursor', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a window whose top frame scrolled off reads unknown', () => {
    const lines = fixture('idle').split('\n');
    const at = lines.findIndex((line) => line === '  → Plan, search, build anything');
    const only = lines.slice(at).join('\n');
    expect(readScreen('cursor', only).kind).toBe('unknown');
    const held = only.replace('  → Plan, search, build anything', '  → Rules.');
    expect(readScreen('cursor', held).kind).toBe('unknown');
    expect(boxHoldsText('cursor', 'Rules.', held)).toBe(false);
  });
});

describe('the person\'s own box, captured (Cursor)', () => {
  // The typed fixtures (see the fixtures README): a person's text typed into Cursor's own box
  // and never sent. Each box reads back as exactly its own text, and as nothing else.
  const CAPTURES: [string, string][] = [
    ['typed-two-line', 'alpha typed line one\nbeta typed line two'],
    ['pasted-two-line', 'gamma pasted first\ndelta pasted second'],
    ['typed-glyph-second', 'epsilon first line\n→ zeta glyph second'],
    ['typed-gt-second', 'eta first line\n> theta gt second'],
    ['typed-wrap', 'iota long line that wraps at the pane width through several words to show the continuation column of a wrapped row on this screen'],
    ['typed-blank-middle', 'kappa first line\n\nlambda third line'],
  ];

  test.each(CAPTURES)('%s reads unsent and holds exactly its text', (name, text) => {
    const screen = fixture(name);
    expect(readScreen('cursor', screen).kind).toBe('unsent');
    expect(classifyComposer('cursor', screen.split('\n')).kind).toBe('unsent');
    expect(boxHoldsText('cursor', text, screen)).toBe(true);
  });

  test.each(CAPTURES)('%s is refused for any other text', (name, text) => {
    const screen = fixture(name);
    expect(boxHoldsText('cursor', `${text}.`, screen)).toBe(false);
    expect(boxHoldsText('cursor', `${text}\nand one more`, screen)).toBe(false);
    expect(boxHoldsText('cursor', CAPTURED_WRAP, screen)).toBe(false);
    expect(boxHoldsText('cursor', NUDGE_TEXT, screen)).toBe(false);
  });

  test('no capture holds another capture\'s text', () => {
    for (const [name, text] of CAPTURES) {
      for (const [other] of CAPTURES) {
        if (other !== name) expect(boxHoldsText('cursor', text, fixture(other))).toBe(false);
      }
    }
  });

  test('the glyph second line is drawn at the content column, never at the prompt column', () => {
    // The capture's own proof, tied to the twin test above: the person's second line begins
    // with `→` and the CLI draws it at the fourth column — the continuation indent — not at
    // the prompt's second.
    expect(readBox('cursor', fixture('typed-glyph-second'))).toEqual({
      first: 'epsilon first line',
      indent: 4,
      rows: ['    → zeta glyph second'],
      wrap: { continuation: 'text-column', kind: 'word' },
    });
  });
});

describe('the closed Cursor status row', () => {
  // A line carrying the closed grammar outside the status position is ordinary text: these
  // screens are the false rows a transcript, a dialog or a box could paint — a grammar line
  // with no workspace line under it, a full row below a real footer, a row after a trust
  // anchor — and each must read what the same screen without that row reads, never idle or
  // unsent the pane does not show. A row that keeps every closed token and sits in the
  // footer's place is a real row: it is accepted, and the model it names is the model read.
  // The six captured panes (see the fixtures README) are the only shipped fixtures whose
  // reading differs from what main read: a constructed screen below moves only where this
  // block pins it — a complete frame reproduced in place, a model narrowed to unread when
  // the real footer is out of place, or a row the closed grammar refuses.
  const GROK = '  Grok 4.7 256K High                 Run Everything';
  const GPT_ROW = '  GPT-5.6 Sol 272K High              Run Everything';
  const COMPOSER_ROW = '  Composer 2.5                       Run Everything';
  const rows = (name: string) => fixture(name).replace(/\n+$/, '').split('\n');
  const text = (lines: string[]) => lines.join('\n');
  const read = (screen: string) => {
    const lines = screen.split('\n');
    return `${classify('cursor', lines).kind} / ${classifyComposer('cursor', lines).kind}`;
  };
  const model = (screen: string) => runningModel('cursor', screen);
  const put = (name: string, n: number, line: string) => {
    const lines = rows(name);
    lines[n - 1] = line;
    return text(lines);
  };
  const footer = (name: string, line: string) =>
    put(name, rows(name).findIndex((row) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(row)) + 1, line);

  test('ordinary output where the footer was reads unknown, as main read it', () => {
    const lines = [
      '  Step 2',
      '  Version 1.2 Released',
      '  HTTP 200 OK',
      '  Added 2 Files',
      '  Item 2',
      '  Release 2',
      '  NODE22.log',
      '  Python 3.12 · 45%',
      '  Node 22',
      '  3 files edited',
      '  A1',
      '  Run Everything',
      '  Report 2 Run Everything',
    ];
    for (const line of lines) {
      const screen = footer('idle', line);
      expect(read(screen)).toBe('unknown / unknown');
      expect(model(screen)).toBeNull();
    }
  });

  test('a model-shaped line missing its closed tokens is not a status row', () => {
    const gpt = footer('idle', '  GPT-5.6 Sol 272K High'); // output text, no `Run Everything`
    expect(read(gpt)).toBe('unknown / unknown');
    expect(model(gpt)).toBeNull();
    const composer = footer('gpt-sol-idle', '  Composer 2.5');
    expect(read(composer)).toBe('unknown / unknown');
    expect(model(composer)).toBeNull();
    const muse = footer('idle', '  Muse Spark 1.3                    Run Everything'); // family unknown
    expect(read(muse)).toBe('unknown / unknown');
    expect(model(muse)).toBeNull();
    const big = footer('idle', '  GPT-5.6 Sol 1M High                Run Everything'); // context unknown
    expect(read(big)).toBe('unknown / unknown');
    expect(model(big)).toBeNull();
  });

  test('the version, the quota and the file count are digits in closed runs', () => {
    // The probes: `[\d.]+` read `5..6`, a bare `.` and `4..2%` as tokens — a version,
    // a quota or a file count that no pane draws. The closed runs cannot, on either side: the
    // status line's grammar and the status_model rule.
    const row = (text: string) => `  ${text}${' '.repeat(24)}Run Everything`;
    for (const line of [
      row('GPT-5..6 Sol 272K High'),
      row('Composer .'),
      row('Composer 2.5 · 4..2%'),
      row('Gemini 3.8 Flash · .%'),
      row('Composer 2.5 · 12. files edited'),
      row('Composer 2.5.1. High'),
    ]) {
      const screen = footer('idle', line);
      expect(read(screen)).toBe('unknown / unknown');
      expect(model(screen)).toBeNull();
    }
    expect(model(row('GPT-5..6 Sol 272K High'))).toBeNull();
    // A multi-part version and a fractional quota are still closed runs that match.
    const good = footer('idle', row('Composer 2.5.1 · 12.5%'));
    expect(read(good)).toBe('idle / idle');
    expect(model(good)).toEqual({ model: 'Composer', version: '2.5.1' });
  });

  test('a painted running screen stays working, and gains no status row', () => {
    const screen = footer('working', '  Step 2');
    expect(read(screen)).toBe('working / unknown');
    expect(model(screen)).toBeNull();
  });

  test('a running frame with its spinner and ctrl+c removed is unknown, never idle', () => {
    const lines = rows('working')
      .filter((line) => !/^\s*[⠀-⣿]/.test(line))
      .map((line) => line.replace(/\s*ctrl\+c to stop\s*$/, ''));
    lines[lines.findIndex((row) => row === GROK)] = '  Step 2';
    const screen = text(lines);
    expect(read(screen)).toBe('unknown / unknown');
    expect(model(screen)).toBeNull();
  });

  test('a finished turn and an exited shell with the footer replaced are unknown', () => {
    expect(read(footer('rules-accepted', '  Step 2'))).toBe('unknown / unknown');
    const exited = put('idle', 12, '  Step 2').split('\n');
    exited[12] = '❯';
    expect(read(text(exited))).toBe('unknown / unknown');
  });

  test('a false footer with no input row above it is unknown', () => {
    const lines = rows('idle').filter((_, i) => i !== 8);
    lines[lines.findIndex((row) => row === GROK)] = '  Step 2';
    expect(read(text(lines))).toBe('unknown / unknown');
  });

  test('the trust dialog closes as trust with output below its anchor', () => {
    expect(read(`${text(rows('trust'))}\n  Step 2`)).toBe('trust / unknown');
    const inside = rows('trust');
    inside.splice(inside.findIndex((row) => /Use arrow keys to navigate, Enter to/.test(row)), 0, '  Step 2');
    expect(read(text(inside))).toBe('trust / unknown');
  });

  test('a quiet follow-up queue reads idle exactly as main read it', () => {
    const lines = rows('follow-up-queue-hint').filter((line) => !/^\s*[⠀-⣿]/.test(line));
    lines.splice(lines.findIndex((row) => /enter interrupt and send/.test(row)) + 1, 0, '  Step 2');
    const screen = text(lines);
    expect(read(screen)).toBe('idle / idle');
    expect(model(screen)).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('prose below the footer leaves the model unread: the row is out of place', () => {
    const prose = `${text(rows('idle'))}\n  GPT-5.6 Sol completed the task`;
    expect(read(prose)).toBe('unknown / unknown');
    // The workspace line is no longer the pane's last non-blank one, so its footer is not the
    // status row and names no model. Main read Grok 4.7 off that footer; a line the pane does
    // not draw as the row is not where the model comes from.
    expect(model(prose)).toBeNull();
  });

  test('a working screen with a line appended stays working and unknown', () => {
    const screen = `${text(rows('working'))}\n  Step 2`;
    expect(read(screen)).toBe('working / unknown');
    // The appended line sits under the workspace line, so the footer above it is not the row:
    // no row, no model.
    expect(model(screen)).toBeNull();
  });

  test('a Grok row the closed grammar does not spell is not a row, whatever main read', () => {
    // Main accepted any leading whitespace before the family (`^\s+Grok\s+[0-9]`). The
    // captures draw exactly two spaces, and the closed grammar keeps only that: a row with
    // one space, three spaces or a tab is ordinary text — no row, no model. The narrowing
    // can only take a reading away, never invent one.
    for (const lead of [' ', '   ', '\t']) {
      const screen = footer('idle', `${lead}Grok 4.7 256K High                 Run Everything`);
      expect(read(screen)).toBe('unknown / unknown');
      expect(model(screen)).toBeNull();
    }
  });

  test('a spoofed row names no model, and the same rows in place still name theirs', () => {
    // A full row below a real footer: the spoof has no workspace line under it, and the real
    // footer's own workspace line is no longer the pane's last — neither is the row.
    expect(model(`${text(rows('gpt-sol-idle'))}\n${GPT_ROW}`)).toBeNull();
    // A full row after the trust dialog's anchor: no workspace line under it.
    expect(model(`${text(rows('trust'))}\n${GPT_ROW}`)).toBeNull();
    // A row in the footer's place with the workspace line removed: not the row.
    expect(model(text(rows('gpt-sol-idle').slice(0, -1)))).toBeNull();
    // A Composer-shaped spoof below a real Grok footer names no model either: a seat running
    // Grok is not renamed by it.
    expect(model(`${text(rows('idle'))}\n${COMPOSER_ROW}`)).toBeNull();
    // The rows that are in place still name their models.
    expect(model(text(rows('gpt-sol-idle')))).toEqual({ model: 'GPT Sol', version: '5.6' });
    expect(model(`${text(rows('idle'))}\n${GROK}`)).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('a full status row is taken by its position: the lowest one wins', () => {
    const above = rows('idle');
    above.splice(above.findIndex((row) => /^ {2}→/.test(row)) - 2, 0, GROK); // a full row in the transcript
    expect(read(text(above))).toBe('idle / idle'); // the real footer below it wins
    expect(model(text(above))).toEqual({ model: 'Grok', version: '4.7' });
    // Below the real footer the appended row is the status row, and the footer above it reads
    // as text left in the box — main reads it the same way, and it is a position gap, not a row gap.
    const below = `${text(rows('idle'))}\n${GROK}`;
    expect(read(below)).toBe('unsent / unsent');
    expect(model(below)).toEqual({ model: 'Grok', version: '4.7' });
    // The status row needs no workspace line under it, and tolerates exactly one.
    expect(read(text(rows('idle').slice(0, -1)))).toBe('idle / idle');
    expect(read(`${text(rows('idle'))}\n  extra`)).toBe('unknown / unknown');
  });

  test('a full row in the status position is a real row; the model it names is read', () => {
    const gpt = footer('idle', GPT_ROW);
    expect(read(gpt)).toBe('idle / idle');
    expect(model(gpt)).toEqual({ model: 'GPT Sol', version: '5.6' });
    const typed = put('gpt-sol-idle', 9, `  → ${GPT_ROW.slice(2)}`);
    expect(read(typed)).toBe('unsent / unsent');
    expect(model(typed)).toEqual({ model: 'GPT Sol', version: '5.6' });
  });

  test('a new-family row outside the status position is ordinary text, not the row', () => {
    const base = text(rows('gpt-sol-idle'));
    expect(read(base)).toBe('idle / idle'); // the captured frame: the row sits above its workspace line
    // A row in the transcript, above the input row: the footer in place below stays the row,
    // and the screen reads exactly as the capture does.
    const above = rows('gpt-sol-idle');
    above.splice(above.findIndex((row) => /^ {2}→/.test(row)) - 2, 0, GPT_ROW);
    expect(read(text(above))).toBe('idle / idle');
    // No workspace line under the row: it is not in the position, and it reads no row.
    expect(read(text(rows('gpt-sol-idle').slice(0, -1)))).toBe('unknown / unknown');
    // A non-workspace line under the row: same.
    expect(read(put('gpt-sol-idle', rows('gpt-sol-idle').length, '  something else'))).toBe('unknown / unknown');
    // A blank line between the row and the workspace line: the workspace line is not directly
    // below the row, so the row is out of place and the screen reads no row and no model.
    const gapped = rows('gpt-sol-idle');
    gapped.splice(gapped.findIndex((row) => /^ {2}GPT-/.test(row)) + 1, 0, '');
    expect(read(text(gapped))).toBe('unknown / unknown');
    expect(model(text(gapped))).toBeNull();
    // A non-blank line under the workspace line: it is not the pane's last, so neither the
    // footer nor the appended row is in the position.
    expect(read(`${base}\n${GPT_ROW}`)).toBe('unknown / unknown');
    // No input row above the row: the frame is not the capture's, and no row is read.
    const input = rows('gpt-sol-idle').findIndex((row) => /^ {2}→/.test(row));
    expect(read(text(rows('gpt-sol-idle').filter((_, i) => i !== input)))).toBe('unknown / unknown');
  });

  test('the input row sits above the status row within the captured distance', () => {
    // Every composer capture draws the input row three to five rows above the status row
    // (measured over the idle, startup, unsent, working, thinking, queue and typed frames).
    // Five holds, six does not: a row further above is not the input row the frame draws.
    const box = (extra: number) => {
      const lines = rows('gpt-sol-idle');
      const at = lines.findIndex((row) => /^ {2}→/.test(row));
      lines.splice(at + 1, 0, ...Array.from({ length: extra }, () => ''));
      return text(lines);
    };
    expect(read(box(2))).toBe('idle / idle'); // distance five
    expect(read(box(3))).toBe('unknown / unknown'); // distance six
  });

  test('a grammar line that is not the row counts for neither the trust rules nor the working queue', () => {
    // The trust dialog with a full row after its anchor: the row has no workspace line under
    // it, so it is ordinary text — the dialog still closes as trust, as main read it, and the
    // composer reads no row.
    expect(read(`${text(rows('trust'))}\n${GPT_ROW}`)).toBe('trust / unknown');
    // A running screen with the row appended: still working, and the composer reads no row.
    expect(read(`${text(rows('working'))}\n${GPT_ROW}`)).toBe('working / unknown');
  });

  test("a new family's model rule is anchored to the row's own line, both ends", () => {
    // The rule itself, applied to a line, so the anchors are pinned at the rule and not only
    // through a screen: one that lost its start anchor would read a family named mid-sentence
    // as the model, and one that lost its end anchor would read a line that runs on past
    // `Run Everything`. The revealing line is one character and then the row exactly as a
    // capture draws it — the two leading spaces included — so a rule that lost only its `^`
    // still begins with those spaces and matches at the second character.
    const captured = [
      '  GPT-5.6 Sol 272K High              Run Everything',
      '  Gemini 3.8 Flash High              Run Everything',
      '  Composer 2.5                       Run Everything',
    ];
    for (const row of captured) expect(statusOnLine('cursor', `x${row}`)).toBeNull();
    for (const row of captured) expect(statusOnLine('cursor', `${row} and more`)).toBeNull();
    // And on a screen: those lines in the footer's place are not the row at all, so the
    // composer's own read names no model either.
    expect(model(footer('idle', 'x  GPT-5.6 Sol 272K High              Run Everything'))).toBeNull();
    expect(model(footer('idle', '  GPT-5.6 Sol 272K High              Run Everything and more'))).toBeNull();
  });

  test('the Grok model rule is anchored to the status row', () => {
    // Main's rule was `(?:^|\s)Grok\s+…`: it read a family name wherever a space or a line
    // start preceded it — mid-sentence as readily as in the row's own place. The anchored rule
    // keeps the rows the captures draw and drops prose that is not a row. It also narrows
    // main's leading whitespace: every Grok row the fixtures hold — the thirteen the captures
    // draw and the four the queue fixtures transcribe — carries exactly the two spaces `^  `
    // spells, and one space, three spaces or a tab is refused where main read a model — a
    // fail-closed narrowing, pinned above.
    expect(statusOnLine('cursor', 'x  Grok 4.7 256K High                 Run Everything')).toBeNull();
    expect(model('x Grok 4.7 wrote it')).toBeNull();
    expect(model('  Grok 4.7 wrote this answer in the transcript')).toEqual({ model: 'Grok', version: '4.7' });
  });

  test('one set of expressions, used in the three places', () => {
    const data = screenData('cursor');
    if (!data || data.composer.mode !== 'status-then-one' || !data.trust || !data.working) {
      throw new Error('cursor profile shape changed');
    }
    // The composer's status_line, the trust dialog's none_after and the working queue's
    // exception must hold the same expressions, character for character: the three places
    // that decide whether a line is the status row cannot disagree about which lines those
    // are.
    const status = data.composer.statusLine.map((re) => re.source);
    const trustRows = (data.trust.rules[0]?.noneAfter?.patterns.slice(1) ?? []).map((p) => p.match.source);
    const workingRows = data.working.rules[1]?.noneAfter?.patterns[0]?.except.map((re) => re.source) ?? [];
    expect(trustRows).toEqual(status);
    for (const source of status) expect(workingRows).toContain(source);
    expect(status.some((source) => source.includes('Run Everything'))).toBe(true);
    expect(status.some((source) => source.includes('GPT-'))).toBe(true);
  });
});

describe('the box\'s own border (Cursor)', () => {
  // The 2026-10-05 captures (see the fixtures README): this installed build draws the box
  // between two border rows — one leading space then only the block character, the ` ▄` row
  // directly above the input row and the ` ▀` row directly below the input rows and directly
  // above the status row — where the 2026-10-01 captures draw up to four empty rows above the
  // input row and two under the text. Each frame is read by its own complete shape; the
  // readings below are the captures' own. The bordered box never reads `idle` or `unsent`
  // from anything but these frames.
  const CAPTURES: [string, ReturnType<typeof readScreen>['kind'], ReturnType<typeof readScreen>['kind']][] = [
    ['bordered-idle', 'idle', 'idle'],
    ['bordered-typed-one', 'unsent', 'unsent'],
    ['bordered-typed-three', 'unsent', 'unsent'],
    ['bordered-after-round', 'idle', 'idle'],
    ['bordered-working', 'working', 'unsent'],
    ['bordered-working-typed', 'working', 'unsent'],
    ['bordered-after-exit', 'unknown', 'unknown'],
  ];

  test.each(CAPTURES)('%s reads %s, its composer %s', (name, whole, composer) => {
    const lines = fixture(name).split('\n');
    expect(readScreen('cursor', fixture(name)).kind).toBe(whole);
    expect(classify('cursor', lines).kind).toBe(whole);
    expect(classifyComposer('cursor', lines).kind).toBe(composer);
  });

  test('the frame rows sit directly against the input row and the status row, nowhere else', () => {
    // The captures' own geometry, tied to the readings above: the ` ▄` row is the row directly
    // above the input row, the ` ▀` row the row directly above the status row, both whole rows
    // at one width, and no other row of the screen is border-shaped.
    const lines = fixture('bordered-typed-three').split('\n');
    const input = lines.findIndex((line) => /^ {2}→/.test(line));
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    expect(lines[input - 1]).toMatch(/^ ▄+$/);
    expect(lines[status - 1]).toMatch(/^ ▀+$/);
    expect(lines[status - 1]?.length).toBe(lines[input - 1]?.length);
    const elsewhere = lines.filter((line, i) => /^ [▄▀]+$/.test(line) && i !== input - 1 && i !== status - 1);
    expect(elsewhere).toEqual([]);
  });
});

describe('a border anywhere else stays unknown (Cursor)', () => {
  // Constructed from the registered captures: each screen below keeps a bordered box's own
  // rows and breaks the frame's shape or place, or plants the pair where the captures draw
  // none. Every one fails closed — never `idle`, never `unsent` — so nothing is typed into
  // these screens and no Enter is sent. The 2026-10-01 captures read the same: they hold no
  // border-shaped row at all (the manifest below), so none of these screens is a frame those
  // captures explain either.
  const source = fixture('bordered-typed-one').replace(/\n+$/, '').split('\n');
  const TOP = source.find((line) => /^ ▄+$/.test(line)) ?? '';
  const BOTTOM = source.find((line) => /^ ▀+$/.test(line)) ?? '';
  const top = source.findIndex((line) => /^ ▄+$/.test(line));
  const input = source.findIndex((line) => /^ {2}→/.test(line));
  const bottom = source.findIndex((line) => /^ ▀+$/.test(line));
  const status = source.findIndex((line) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(line));
  const statusLen = (source[status] ?? '').length;
  const text = (lines: string[]) => lines.join('\n');
  const unknown = (screen: string) => {
    expect(readScreen('cursor', screen).kind).toBe('unknown');
    expect(classify('cursor', screen.split('\n')).kind).toBe('unknown');
    expect(classifyComposer('cursor', screen.split('\n')).kind).toBe('unknown');
  };

  test('one border row missing', () => {
    unknown(text(source.filter((_, i) => i !== input - 1))); // the top row gone
    unknown(text(source.filter((_, i) => i !== bottom))); // the bottom row gone
  });

  test('the rows swapped: ` ▀` above the input, ` ▄` below it', () => {
    const swapped = [...source];
    swapped[input - 1] = BOTTOM;
    swapped[bottom] = TOP;
    unknown(text(swapped));
  });

  test('a border row with another character in it or with text after it', () => {
    const junk = [...source];
    junk[top] = `${TOP.slice(0, 10)}X${TOP.slice(11)}`;
    unknown(text(junk));
    const after = [...source];
    after[bottom] = `${BOTTOM} ok`;
    unknown(text(after));
  });

  test('a border one row away from the input, an empty row between', () => {
    const underTop = [...source];
    underTop.splice(input, 0, '');
    unknown(text(underTop));
    const overBottom = [...source];
    overBottom.splice(bottom, 0, '');
    unknown(text(overBottom));
  });

  test('a border pair in the transcript above an ordinary box', () => {
    // The blank-framed captures with the pair planted in their transcript, well above the box
    // and pressed against it: a border row anywhere but its place is a shape no capture
    // draws, and the read fails closed rather than take the rows under it for a box. Nothing
    // is typed and no Enter is sent.
    const lines = fixture('idle').replace(/\n+$/, '').split('\n');
    const planted = [...lines.slice(0, 4), TOP, BOTTOM, ...lines.slice(4)];
    unknown(text(planted));
    const pressed = [...lines.slice(0, 8), TOP, BOTTOM, ...lines.slice(8)];
    unknown(text(pressed));
    expect(boxHoldsText('cursor', 'Rules.', text(planted))).toBe(false);
    expect(boxHoldsText('cursor', 'Rules.', text(pressed))).toBe(false);
  });

  test('the bordered box with no status row', async () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    const screen = text(lines.filter((_, i) => i !== status));
    unknown(screen);
    const d = delivery('bordered-idle');
    d.showText(screen);
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('the bordered box with a status row of a family the grammar does not know', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    lines[status] = '  Muse Spark 1.3                    Run Everything';
    unknown(text(lines));
  });

  test('a one-character border and short Grok line reads unknown', () => {
    const screen = [' ▄', '  → ', ' ▀', '  Grok 4', '  ~/x'].join('\n');
    unknown(screen);
  });

  test('a four-character border pair around the real placeholder and status row reads unknown', () => {
    const screen = [
      ' ▄▄▄▄',
      '  → Plan, search, build anything',
      ' ▀▀▀▀',
      '  Grok 4.7 256K High                 Run Everything',
      '  <workspace>',
    ].join('\n');
    unknown(screen);
  });

  test('a shell transcript ending in a border pair, prompt line, and Grok-shaped sentence reads unknown', () => {
    const screen = [
      '❯ echo done',
      'done',
      TOP,
      '  → next step is to build',
      BOTTOM,
      '  Grok 4.7 mentioned in the log',
      '  ~/some/path',
    ].join('\n');
    unknown(screen);
  });

  test('a bordered frame with its workspace line removed reads unknown', () => {
    const typedNoWs = source.filter((line) => !line.includes('<workspace>')).join('\n');
    unknown(typedNoWs);
    const idleLines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const idleNoWs = idleLines.filter((line) => !line.includes('<workspace>')).join('\n');
    unknown(idleNoWs);
  });

  test('a bordered frame with its workspace line replaced with non-path reads unknown', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const ws = lines.findIndex((line) => line.includes('<workspace>'));
    lines[ws] = '  not-a-path';
    unknown(lines.join('\n'));
  });

  test('a bordered frame with its status row cut to Grok 4.7 reads unknown', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const status = lines.findIndex((line) => /^ {2}Grok /.test(line));
    lines[status] = '  Grok 4.7';
    unknown(lines.join('\n'));
  });

  test('a bordered frame with an extra non-blank line after the workspace reads unknown', () => {
    const lines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    lines.push('❯');
    unknown(lines.join('\n'));
  });

  test('border rows of unequal width fail the equal-width check', () => {
    // Both rows match ^ ▄+$ and ^ ▀+$, but differ in length
    const unequalBottom = [...source];
    unequalBottom[bottom] = ' ' + '▀'.repeat(50); // length 51 !== TOP.length (52)
    expect(unequalBottom[bottom].length).toBe(51);
    expect(TOP.length).toBe(52);
    unknown(text(unequalBottom));

    const unequalTop = [...source];
    unequalTop[top] = ' ' + '▄'.repeat(50); // length 51 !== BOTTOM.length (52)
    expect(unequalTop[top].length).toBe(51);
    expect(BOTTOM.length).toBe(52);
    unknown(text(unequalTop));
  });

  test('a border the same length as the status row reads unknown', () => {
    // In every real frame the border row is exactly one character longer than the status row;
    // here both border rows are 51 characters, equal to the 51-character status row.
    const sameLen = [...source];
    sameLen[top] = ' ' + '▄'.repeat(50);
    sameLen[bottom] = ' ' + '▀'.repeat(50);
    expect((sameLen[top] ?? '').length).toBe(statusLen);
    expect((sameLen[bottom] ?? '').length).toBe(statusLen);
    unknown(text(sameLen));
  });

  test('a border two characters longer than the status row reads unknown', () => {
    // Both border rows are 53 characters, two characters longer than the 51-character status row.
    const twoLonger = [...source];
    twoLonger[top] = ' ' + '▄'.repeat(52);
    twoLonger[bottom] = ' ' + '▀'.repeat(52);
    expect((twoLonger[top] ?? '').length).toBe(statusLen + 2);
    expect((twoLonger[bottom] ?? '').length).toBe(statusLen + 2);
    unknown(text(twoLonger));
  });

  test('a border shorter than the status row reads unknown', () => {
    // Both border rows are 50 characters, shorter than the 51-character status row.
    const shorter = [...source];
    shorter[top] = ' ' + '▄'.repeat(49);
    shorter[bottom] = ' ' + '▀'.repeat(49);
    expect((shorter[top] ?? '').length).toBeLessThan(statusLen);
    expect((shorter[bottom] ?? '').length).toBeLessThan(statusLen);
    unknown(text(shorter));
  });

  test('a bottom border with trailing text at the same width', () => {
    // Bottom border carries trailing text matching TOP.length (52 chars):
    // ^ ▀+$ must reject the trailing characters even though the length is identical
    const sameWidth = [...source];
    sameWidth[bottom] = `${BOTTOM.slice(0, 49)} ok`; // 49 block chars + ' ok' = 52 chars
    expect(sameWidth[bottom].length).toBe(TOP.length);
    unknown(text(sameWidth));
  });

  test('border rows with two leading spaces read unknown', () => {
    const twoLeadingTop = [...source];
    twoLeadingTop[top] = '  ' + '▄'.repeat(50);
    unknown(text(twoLeadingTop));

    const twoLeadingBottom = [...source];
    twoLeadingBottom[bottom] = '  ' + '▀'.repeat(50);
    unknown(text(twoLeadingBottom));

    const twoLeadingBoth = [...source];
    twoLeadingBoth[top] = '  ' + '▄'.repeat(50);
    twoLeadingBoth[bottom] = '  ' + '▀'.repeat(50);
    unknown(text(twoLeadingBoth));
  });

  test('a shell transcript catting the complete idle frame with no shell prompt after it reads idle as an accepted boundary', async () => {
    const idleLines = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
    const screen = [
      '❯ cat frame.txt',
      ...idleLines,
    ].join('\n');
    expect(readScreen('cursor', screen).kind).toBe('idle');
    expect(classify('cursor', screen.split('\n')).kind).toBe('idle');

    const withPrompt = `${screen}\n❯`;
    unknown(withPrompt);

    const shellIo: Delivery = {
      screen: () => screen,
      status: () => 'idle',
      type: () => true,
      enter: () => true,
      foreground: () => ['zsh'],
      now: () => 0,
      sleep: async () => {},
    };
    expect(await deliverRules('cursor', 'Rules.', 1, shellIo)).toBe('no-agent');
  });
});

describe('a border around a dialog (Cursor)', () => {
  // Each registered dialog with the captures' border rows wrapped around its box rows: the
  // pair is not a dialog's frame, and the composer must not read the dialog's rows under it
  // as an input box. Each still reads exactly what it read before — never `idle`, never
  // `unsent`.
  const WRAPS: [string, RegExp, RegExp][] = [
    ['trust', /^  ╭─+╮$/, /^  ╰─+╯$/],
    ['trust-54', /^  ╭─+╮$/, /^  ╰─+╯$/],
    ['question', /^ ┌─+┐$/, /^ └─+┘$/],
    ['permission-plan', /^━{8,}$/, /^    Reject \(n or esc\)$/],
  ];
  const bordered = fixture('bordered-typed-one').replace(/\n+$/, '').split('\n');
  const TOP = bordered.find((line) => /^ ▄+$/.test(line)) ?? '';
  const BOTTOM = bordered.find((line) => /^ ▀+$/.test(line)) ?? '';
  const wrapped = (name: string, first: RegExp, last: RegExp) => {
    const lines = fixture(name).replace(/\n+$/, '').split('\n');
    const a = lines.findIndex((line) => first.test(line));
    const b = lines.findIndex((line) => last.test(line));
    if (a < 0 || b < 0) throw new Error(`${name} has no box rows`);
    return [...lines.slice(0, a), TOP, ...lines.slice(a, b + 1), BOTTOM, ...lines.slice(b + 1)].join('\n');
  };

  test.each(WRAPS)('%s with its box rows wrapped reads what it read before', (name, first, last) => {
    const original = fixture(name).split('\n');
    const screen = wrapped(name, first, last);
    const before = `${classify('cursor', original).kind} / ${classifyComposer('cursor', original).kind}`;
    const after = `${classify('cursor', screen.split('\n')).kind} / ${classifyComposer('cursor', screen.split('\n')).kind}`;
    expect(after).toBe(before);
    expect(before).not.toBe('idle / idle');
    expect(before).not.toBe('unsent / unsent');
  });
});

describe('the border inserted around every other capture (Cursor)', () => {
  // The generated set: every Cursor fixture that draws no border — the registered captures of
  // 2026-10-01 through 2026-10-05, the `bordered-` captures excluded because they already
  // draw the frame and are read above — with the captures' border rows inserted around its
  // input rows: the ` ▄` row directly above the input row and the ` ▀` row directly above the
  // status row (directly under the input row where the screen shows no status row), the
  // empty rows they displace being the frame's. Each reads exactly what its original reads —
  // an `idle` original stays `idle`, `working` stays `working`, a dialog stays that dialog —
  // so the border never changes a reading by itself. The dialogs take the item above's wrap;
  // count and result are in the result document.
  const DIR = new URL('../fixtures/cursor/2026.10.01/', import.meta.url);
  const NAMES = readdirSync(DIR)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => file.slice(0, -'.txt'.length))
    .filter((name) => !name.startsWith('bordered'))
    .sort();
  const bordered = fixture('bordered-idle').replace(/\n+$/, '').split('\n');
  const TOP = bordered.find((line) => /^ ▄+$/.test(line)) ?? '';
  const BOTTOM = bordered.find((line) => /^ ▀+$/.test(line)) ?? '';
  const DIALOGS: Record<string, [RegExp, RegExp]> = {
    trust: [/^  ╭─+╮$/, /^  ╰─+╯$/],
    'trust-54': [/^  ╭─+╮$/, /^  ╰─+╯$/],
    question: [/^ ┌─+┐$/, /^ └─+┘$/],
    'permission-plan': [/^━{8,}$/, /^    Reject \(n or esc\)$/],
  };

  const framed = (name: string) => {
    const lines = fixture(name).replace(/\n+$/, '').split('\n');
    const input = lines.findLastIndex((line) => /^ {2}→/.test(line));
    const status = lines.findLastIndex((line) => /^ {2}(?:Grok|GPT-|Gemini |Composer )/.test(line));
    const out = [...lines];
    out[input - 1] = TOP; // the row above every capture's input row is one of its frame's empty rows
    if (status > input) {
      let last = status - 1;
      while (last > input && (out[last] ?? '').trim() === '') last--;
      out.splice(last + 1, status - 1 - last, BOTTOM); // the frame's empty rows give way to the row
    } else {
      out.splice(input + 1, 1, BOTTOM); // no status row: the row sits directly under the input row
    }
    return out.join('\n');
  };

  const withDialogWrap = (name: string) => {
    const [first, last] = DIALOGS[name] ?? [];
    if (!first || !last) return framed(name);
    const lines = fixture(name).replace(/\n+$/, '').split('\n');
    const a = lines.findIndex((line) => first.test(line));
    const b = lines.findIndex((line) => last.test(line));
    return [...lines.slice(0, a), TOP, ...lines.slice(a, b + 1), BOTTOM, ...lines.slice(b + 1)].join('\n');
  };

  test('every fixture of the set reads what its original reads', () => {
    const differed: string[] = [];
    for (const name of NAMES) {
      const original = fixture(name).split('\n');
      const inserted = withDialogWrap(name).split('\n');
      const before = classify('cursor', original).kind;
      const after = classify('cursor', inserted).kind;
      if (after !== before) differed.push(`${name}: ${before} -> ${after}`);
    }
    expect(differed).toEqual([]);
    expect(NAMES.length).toBe(29);
    expect(NAMES).toContain('idle');
    expect(NAMES).toContain('working');
    expect(NAMES).toContain('trust');
    expect(NAMES).toContain('question');
    expect(NAMES).toContain('permission-plan');
  });
});

describe('the bordered box read back (Cursor)', () => {
  // The read-back over the three-row capture: the box the reader takes must be the rows
  // between the frame's own rows — the typed text, not the border — so `deliver.ts` reads a
  // bordered box unchanged. The text read back is exactly what was typed.
  const TYPED = ['alpha bordered line one', 'beta bordered line two', 'gamma bordered line three'];
  const TEXT = TYPED.join('\n');

  test('the three-row capture reads unsent and its box is exactly the typed text', () => {
    const screen = fixture('bordered-typed-three');
    expect(readScreen('cursor', screen).kind).toBe('unsent');
    expect(classifyComposer('cursor', screen.split('\n')).kind).toBe('unsent');
    expect(readBox('cursor', screen)).toEqual({
      first: 'alpha bordered line one',
      indent: 4,
      rows: ['    beta bordered line two', '    gamma bordered line three'],
      wrap: { continuation: 'text-column', kind: 'word' },
    });
    expect(boxHoldsText('cursor', TEXT, screen)).toBe(true);
    expect(boxHoldsText('cursor', 'alpha bordered line one', fixture('bordered-typed-one'))).toBe(true);
  });

  test('another text is refused', () => {
    expect(boxHoldsText('cursor', `${TEXT}\nand one more`, fixture('bordered-typed-three'))).toBe(false);
    expect(boxHoldsText('cursor', CAPTURED_WRAP, fixture('bordered-typed-three'))).toBe(false);
    expect(boxHoldsText('cursor', NUDGE_TEXT, fixture('bordered-typed-three'))).toBe(false);
  });

  test('rules delivery types the three rows into the bordered box, reads them back and enters', async () => {
    const d = delivery('bordered-idle');
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(borderedBox(text.split('\n')));
      return true;
    };
    expect(await deliverRules('cursor', TEXT, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([TEXT, 'Enter']);
  });
});
