import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { antigravity, antigravityModel } from '../../src/profiles/antigravity.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { downPlan, upPlan } from '../../src/launch/plan.ts';
import { pass, newMemory } from '../../src/watch/pass.ts';
import { emptySession } from '../../src/state.ts';
import { stateOf } from '../../src/commands/down.ts';
import { validateTeamFile } from '../../src/file/validate.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/antigravity/1.2.16/${name}.txt`, import.meta.url), 'utf8');

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
    ['working', 'unknown'],
    ['rules-accepted', 'idle'],
    ['trust', 'trust'],
    ['permission', 'permission'],
    ['exit-typed', 'unsent'],
    ['exit', 'unknown'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('antigravity', fixture(file)).kind).toBe(kind);
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
    expect(antigravityModel('gemini-3.8-flash-medium')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(antigravityModel('gemini-3.7-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.7' });
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

function delivery(initial = 'idle') {
  let shown = initial;
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const io: Delivery = {
    screen: () => fixture(shown),
    status: () => status,
    type(text) { calls.push(text); shown = 'unsent'; return true; },
    enter() { calls.push('Enter'); shown = 'working'; status = 'working'; return true; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, show: (name: string) => { shown = name; }, status: (value: string) => { status = value; } };
}

describe('Antigravity rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
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
    d.io.sleep = async (ms) => { clock += ms; d.show('unsent'); };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
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
    const result = pass(
      teamFile,
      emptySession(),
      {
        running: true,
        agents: [{ name: 'gemini', agent: 'agy', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
        workspaces: [{ id: 'w1', label: 'gemini' }],
        screens: { 'w1:p1': fixture('permission') },
      },
      { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 },
      0,
      memory,
    );
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
