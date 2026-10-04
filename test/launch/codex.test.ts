import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codex } from '../../src/profiles/codex.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { upPlan } from '../../src/launch/plan.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

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

function delivery(initial = 'idle') {
  let shown = initial;
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const io: Delivery = {
    screen: () => fixture(shown), status: () => status,
    type(text) { calls.push(text); shown = 'unsent'; return true; },
    enter() { calls.push('Enter'); shown = 'working'; status = 'working'; return true; },
    now: () => clock, sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, show: (name: string) => { shown = name; }, status: (value: string) => { status = value; } };
}

describe('Codex rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
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
    d.io.sleep = async (ms) => { clock += ms; d.show('unsent'); };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
  });
});
