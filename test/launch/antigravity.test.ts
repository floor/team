import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { boxHoldsText, deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { rulesText, type RulesInput } from '../../src/launch/rules.ts';
import { downPlan, upPlan } from '../../src/launch/plan.ts';
import { pass, newMemory } from '../../src/watch/pass.ts';
import { emptySession } from '../../src/state.ts';
import { stateOf } from '../../src/commands/down.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { wordWrap } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/antigravity/1.2.16/${name}.txt`, import.meta.url), 'utf8');

const antigravity = profileFor('antigravity');
if (!antigravity) throw new Error('antigravity has no profile');

describe('Antigravity launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(launchCommand(antigravity, 'agy --model gemini-3.8-flash-high', 'Rules.')).toBe('AGENT_UNATTENDED=1 agy --model gemini-3.8-flash-high --dangerously-skip-permissions');
    expect(antigravity.rulesOption).toBeNull();
    expect(antigravity.loginCheck).toEqual(['models']);
    expect(antigravity.loginHint).toBe('agy');
    expect(antigravity.exit).toBe('/exit');
    expect(versionVerdict('1.2.16', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.2.18', antigravity.tested)).toBe('newer');
    expect(versionVerdict('1.2.10', antigravity.tested)).toBe('older');
  });

  test.each([
    ['idle', 'idle'],
    ['unsent', 'unsent'],
    ['working', 'working'],
    ['rules-accepted', 'idle'],
    ['trust', 'trust'],
    ['permission', 'permission'],
    ['exit-typed', 'unsent'],
    ['exit', 'unknown'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('antigravity', fixture(file)).kind).toBe(kind);
  });
  test('a permission dialog with a running turn beside it is still permission, not working', () => {
    // The turn's "Generating..." line stays visible while the dialog is up: the dialog shape is
    // read first, as for claude-code.
    const screen = fixture('permission').replace('Command\n', 'Command\n⣯  Generating...\n');
    expect(readScreen('antigravity', screen).kind).toBe('permission');
  });

  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [
      undefined,
      '❯\n',
      '>\n',
      'Welcome to Antigravity\nSign in to continue',
      'Do you allow this command?\n> 1. Yes\nEnter to confirm',
    ]) {
      expect(readScreen('antigravity', screen).kind).toBe('unknown');
    }
    expect(readScreen('antigravity', fixture('idle').replace('? for shortcuts               Gemini 3.8 Flash · high', 'new footer')).kind).toBe('unknown');
  });

  test('a quoted trust or permission dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('antigravity', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('antigravity', fixture('permission') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('antigravity', fixture('idle').replace('─────────────────────────────────────────────────────\n>', '─────────────────────────────────────────────────────\n>\n  unsent second line')).kind).toBe('unsent');
  });

  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(antigravity.modelOf('agy --model gemini-3.8-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(antigravity.modelOf('agy --model=gemini-3.1-pro-low')).toEqual({ model: 'Gemini Pro', version: '3.1' });
    expect(antigravity.modelOf('agy --model unknown-model')).toBeNull();
    expect(antigravity.modelOf('agy')).toBeNull();
    expect(antigravity.modelOf('agy --model gemini-3.8-flash-medium')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(antigravity.modelOf('agy --model gemini-3.7-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.7' });
    expect(antigravity.modelOf('agy --model gemini-3.8-flash-high --model gemini-3.1-pro-low')).toEqual({ model: 'Gemini Pro', version: '3.1' });
    expect(runningModel('antigravity', fixture('idle'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(runningModel('antigravity', fixture('rules-accepted'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(runningModel('antigravity', fixture('trust'))).toBeNull();
  });

  test('the plan delivers through the guarded first-message path, never a config file', () => {
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      seats: [{ name: 'gemini', cli: 'antigravity', launch: 'agy', cwd: '.', label: 'gemini', stopped: false, rules: 'Rules.' }],
    });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({ do: 'deliver', cli: 'antigravity', rules: 'Rules.', seconds: 90 });
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });
});

/** The captured idle frame once `text` sits in the box: the bare prompt row replaced, the text's
 *  first line after the prompt, every later line at the column the `unsent` capture draws
 *  continuation rows in — two columns, the prompt's own width (see the fixtures README). */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('\n>\n', `\n${body}\n`);
}

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['agy'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Antigravity rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a shorter first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('an ordinary box whose rows are the typed line hard-wrapped is entered', async () => {
    // No Antigravity capture shows its composer wrapping an ordinary line — a long paste folds —
    // so no wrap is modelled for it: the box rows must read back as the typed line laid out in
    // order, the continuation at the prompt row's two columns, and then the Enter is the paste's.
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const chunks: string[] = [];
    for (let at = 0; at < long.length; at += 53) chunks.push(long.slice(at, at + 53));
    expect(chunks.length).toBeGreaterThan(1);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(chunks.join('\n'))); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([long, 'Enter']);
  });

  test('a hard-wrapped box with one character changed gets no Enter', async () => {
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const changed = long.replace('reply ready', 'reply reidy');
    const chunks: string[] = [];
    for (let at = 0; at < changed.length; at += 53) chunks.push(changed.slice(at, at + 53));
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(chunks.join('\n'))); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([long]);
  });

  test('a word-wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of the typed line: the pane draws one only where
    // the text itself has a blank line, and this line has none.
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const rows = wordWrap(long, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed([firstRow, '', ...rest].join('\n'))); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([long]);
  });

  test('a trailing blank row after the word-wrapped line gets no Enter', async () => {
    // No capture shows Antigravity drawing an empty row of its own inside the box — idle.txt's
    // composer is the bare `>` row and unsent.txt's rows sit directly between the rules — so a
    // trailing blank row is never the pane's frame: it is a row the text does not have.
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const rows = wordWrap(long, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const body = [`> ${firstRow}`, ...rest.map((row) => `  ${row}`), ''].join('\n');
    const screen = fixture('idle').replace('\n>\n', `\n${body}\n`);
    expect(boxHoldsText('antigravity', long, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([long]);
  });

  test('a blank line the typed text itself has is entered', async () => {
    const typed = 'Rules.\n\nMore rules.';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('antigravity', typed, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([typed, 'Enter']);
  });

  test('two spaces typed, one shown, gets no Enter', async () => {
    // The shared read refuses a box showing a single space where the typed text has two: the
    // wrap did not add or drop it.
    expect(boxHoldsText('antigravity', 'alpha  beta', boxed('alpha beta'))).toBe(false);
  });

  test('a boxed multi-line paste reads back row for row and is entered', async () => {
    const d = delivery();
    expect(await deliverRules('antigravity', 'Rules.\nOne more line.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.\nOne more line.', 'Enter']);
  });

  test.each(['trust', 'permission', 'unsent', 'exit', 'working'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working');
    d.status('idle');
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a trust question appearing after paste gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('trust'); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a dialog arriving at the final re-read gets no Enter', async () => {
    const d = delivery();
    let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'trust' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    }
  });

  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery();
    let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
  });
});

// The rules a lane seat was given, as `up` renders them: the fixture below is this text folded
// in agy's composer at 54 columns (see the fixtures README).
const RULES_INPUT: RulesInput = {
  coordinator: 'floor-30',
  rules: [
    'Work only on the brief in front of you, and skip nothing in it.',
    'Never push: your `ready` file is the hand-off.',
    'Never run `gh`, and never touch `CHANGELOG.md`.',
    'Write the result file beside the brief, then `ready <sha>`.',
  ],
  signature: {
    commit: 'Agent: DeepSeek V4.1 Flash · implementer',
    pullRequest: 'Agent: DeepSeek V4.1 Flash · implementer',
    commitPosition: 'last-line',
  },
  workspace: { mode: 'worktree', protected: [], branch: 'fix/agy-rules-fold' },
};
const RULES = rulesText(RULES_INPUT, 'message');

/** A pane idle before the paste, the given folded pane after it, working after Enter. */
function foldedPane(edit: (screen: string) => string = (screen) => screen) {
  const d = delivery();
  let pasted = false;
  let entered = false;
  d.io.screen = () => (entered ? fixture('working') : pasted ? edit(fixture('folded-rules')) : fixture('idle'));
  d.io.type = (text) => { d.calls.push(text); pasted = true; return true; };
  d.io.enter = () => { d.calls.push('Enter'); entered = true; d.status('working'); return true; };
  return d;
}

describe('Antigravity folded rules paste', () => {
  test('a folded box that holds the typed rules is delivered', async () => {
    const d = foldedPane();
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([RULES, 'Enter']);
  });

  test('the prompt-marked fold reads unsent, and is verified the same way', async () => {
    const marked = (screen: string) => screen.replace('↑ 21 more lines', '> ↑ 21 more lines');
    expect(readScreen('antigravity', marked(fixture('folded-rules'))).kind).toBe('unsent');
    const d = foldedPane(marked);
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([RULES, 'Enter']);
  });

  test('a prompt-marked fold with a wrong count gets no Enter', async () => {
    // Before the fold was read, this box only had to read `unsent` to be submitted unverified.
    const d = foldedPane((screen) => screen.replace('↑ 21 more lines', '> ↑ 22 more lines'));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a fold whose hidden count does not close the gap gets no Enter', async () => {
    const d = foldedPane((screen) => screen.replace('↑ 21 more lines', '↑ 22 more lines'));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a fold whose tail is not the typed text gets no Enter', async () => {
    const d = foldedPane((screen) => screen.replace('d fix/agy-rules-fold.', 'd fix/some-other-branch.'));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a prompt-marked fold whose count cannot be right (zero) gets no Enter', async () => {
    // A marker that claims nothing is hidden while the box shows only its tail. Read as an
    // ordinary unsent box, this got the Enter; a fold marker is never submitted unverified.
    const d = foldedPane((screen) => screen.replace('↑ 21 more lines', '> ↑ 0 more lines'));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a zero-count fold with an unrelated tail gets no Enter either', async () => {
    // The reproduction: prompt-marked marker, count zero, and visible rows that are not the
    // typed text's ending at all.
    const d = foldedPane((screen) => screen
      .replace(
        ['d fix/agy-rules-fold.', 'These are standing rules, not a task: reply ready and ', 'wait for your brief.'].join('\n'),
        ['d fix/some-other-branch.', 'Nothing here is the text team typed, and ', 'the count below is wrong as well.'].join('\n'),
      )
      .replace('↑ 21 more lines', '> ↑ 0 more lines'));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a fold whose count is larger than the text\'s rows gets no Enter', async () => {
    const d = foldedPane((screen) => screen.replace('↑ 21 more lines', '> ↑ 99 more lines'));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a rule-looking row after the true tail gets no Enter', async () => {
    // The pane holds one row the fold read does not cover. Before the frame was read this
    // way, the first rule-looking row under the marker ended the fold, so the row — and
    // everything between it and the box's real bottom rule — was dropped from the read.
    const d = foldedPane((screen) => screen.replace('wait for your brief.\n', `wait for your brief.\n${'─'.repeat(54)}\n`));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('two rule-looking rows after the true tail get no Enter', async () => {
    const d = foldedPane((screen) => screen.replace('wait for your brief.\n', `wait for your brief.\n${'─'.repeat(54)}\n${'─'.repeat(54)}\n`));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a heavy rule-looking row after the true tail gets no Enter', async () => {
    const d = foldedPane((screen) => screen.replace('wait for your brief.\n', `wait for your brief.\n${'━'.repeat(54)}\n`));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('an indented rule-looking row after the true tail counts as content', async () => {
    // Drawn at the content column it is no rule at all: it is a row of the tail the typed
    // text does not have, so the box is not the text and there is no Enter.
    const d = foldedPane((screen) => screen.replace('wait for your brief.\n', `wait for your brief.\n  ${'─'.repeat(54)}\n`));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('a rule-looking row between the opening rule and the marker gets no Enter', async () => {
    // Two rule rows stacked with the marker under the lower one: no capture shows that, and
    // the read cannot tell which rule opens the box, so it fails closed.
    const d = foldedPane((screen) => screen.replace('↑ 21 more lines', `${'─'.repeat(54)}\n↑ 21 more lines`));
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });
});

describe('Antigravity permission prompt in watch and down', () => {
  test('the screen classifier reads permission as blocked, never idle or unsent', () => {
    const screen = readScreen('antigravity', fixture('permission'));
    expect(screen.kind).toBe('permission');
    expect(screen.kind).not.toBe('idle');
    expect(screen.kind).not.toBe('unsent');
  });

  test('watch reports an Antigravity seat at a permission prompt to the owner', () => {
    const memory = newMemory();
    const parsed = validateTeamFile(`
format: 1
project: test
workspace:
  mode: shared
coordinator: gemini
operator: gemini
seats:
  - role: implementer
    name: gemini
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
`);
    if (!parsed.ok) throw new Error('invalid team file');
    const teamFile = parsed.team;
    const result = pass({
      team: teamFile, watch: teamFile.watch,
      state: emptySession(),
      live: {
        running: true,
        agents: [{ name: 'gemini', agent: 'agy', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
        workspaces: [{ id: 'w1', label: 'gemini' }],
        screens: { 'w1:p1': fixture('permission') },
      },
      machine: { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 },
      now: 0,
      memory,
    });
    expect(result.reports).toEqual([{
      key: 'blocked:gemini',
      text: "gemini waits at a permission prompt: its owner's to answer",
      to: 'owner',
    }]);
  });

  test('down treats an Antigravity seat at a permission prompt as blocked and types nothing', () => {
    const screen = readScreen('antigravity', fixture('permission'));
    expect(stateOf('idle', screen)).toBe('blocked');
    expect(stateOf('done', screen)).toBe('blocked');

    const plan = downPlan({
      session: 'test-session',
      seats: [{
        name: 'gemini',
        cli: 'antigravity',
        pane: 'w1:p1',
        workspace: 'w1',
        state: stateOf('idle', screen),
      }],
      keep: [],
      extra: 0,
      watchPid: null,
    });
    expect(plan.find((step) => step.kind === 'skip' && step.text.includes('gemini'))).toEqual({
      kind: 'skip',
      text: 'gemini: is blocked at a prompt, which `team` never answers; left running',
    });
    expect(plan.some((step) => step.do?.do === 'type')).toBe(false);
  });
});

describe('the prompt-glyph continuation row (Antigravity)', () => {
  // The person's box holds their own text, then a continuation row at the content column
  // carrying only the prompt glyph. The input row is the box's first row under its opening
  // rule — unsent.txt draws `>` there, at the pane's first column — never the last row whose
  // content begins with a glyph.
  const GLYPH = '>';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('antigravity', boxed(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `> Rules.`.
    expect(boxHoldsText('antigravity', 'Rules.', boxed(`person text\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(boxed(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a glyph row with text after it and two glyph rows all leave the text above them in the box', () => {
    expect(boxHoldsText('antigravity', 'quoted', boxed(`person text\n${GLYPH} quoted`))).toBe(false);
    expect(readScreen('antigravity', boxed(`person text\n${GLYPH}\n${GLYPH}`)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', 'Rules.', boxed(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });
});
