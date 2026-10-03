import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cursor, cursorModel } from '../../src/profiles/cursor.ts';
import { cursorComposer } from '../../src/profiles/cursor-screen.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { upPlan } from '../../src/launch/plan.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/cursor/2026.10.01/${name}.txt`, import.meta.url), 'utf8');

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

  test('a working turn still has an empty composer, which is what delivery waits for', () => {
    const lines = fixture('working').split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(readScreen('cursor', fixture('working')).kind).toBe('working');
    expect(cursorComposer(lines).kind).toBe('idle');
    const thinking = fixture('thinking').split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(cursorComposer(thinking).kind).toBe('idle');
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
    expect(cursorModel('cursor-grok-4.6-high-fast')).toEqual({ model: 'Grok', version: '4.6' });
    expect(cursorModel('grok-4.7')).toEqual({ model: 'Grok', version: '4.7' });
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

function delivery(initial = 'idle') {
  let shown = initial;
  let status = initial === 'working' || initial === 'thinking' ? 'working' : 'idle';
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

describe('Cursor rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
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
    d.io.sleep = async (ms) => { clock += ms; d.show('unsent'); };
    expect(await deliverRules('cursor', 'Rules.', 1, d.io)).toBe(true);
  });
});
