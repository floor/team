import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classifyWith, guardReading, mergeScreen, parseOverrides } from '../src/profiles/overrides.ts';
import { classifyData, readScreen, screenData } from '../src/watch/screen.ts';

const permission = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
const working = readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8');
const idle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');

function added(stage: string, pattern: string) {
  const parsed = parseOverrides(`format: 1
profiles:
  codex:
    screen:
      ${stage}:
        - any: ['${pattern}']
`);
  if (!parsed.ok) throw new Error(parsed.errors[0]?.message);
  return parsed.profiles;
}

describe('an override moves a reading toward a dialog, never toward idle or unsent', () => {
  test('a shipped permission, trust or question screen still matches', () => {
    expect(readScreen('codex', permission).kind).toBe('permission');
    const profiles = added('unknown', 'Would you like to run');
    const base = screenData('codex');
    const extra = profiles[0];
    if (!base || !extra) throw new Error('codex');
    // The added pattern matches first, so the merged data alone would hide the permission.
    expect(classifyData(mergeScreen(base, extra), permission.split('\n')).kind).toBe('unknown');
    expect(classifyWith('codex', permission, profiles).kind).toBe('permission');
  });

  test('a working screen may become a dialog, and may not become idle or unsent', () => {
    expect(readScreen('codex', working).kind).toBe('working');
    expect(classifyWith('codex', working, added('question', 'esc to interrupt')).kind).toBe('question');
    expect(guardReading({ kind: 'working' }, { kind: 'unsent' }).kind).toBe('working');
    expect(guardReading({ kind: 'working' }, { kind: 'idle' }).kind).toBe('working');
  });

  test('an idle screen stays idle unless the override makes it a dialog', () => {
    expect(readScreen('codex', idle).kind).toBe('idle');
    expect(classifyWith('codex', idle, added('unknown', 'not on this screen')).kind).toBe('idle');
    expect(guardReading({ kind: 'idle' }, { kind: 'unsent' }).kind).toBe('idle');
    expect(guardReading({ kind: 'idle' }, { kind: 'permission' }).kind).toBe('permission');
    expect(guardReading({ kind: 'permission' }, { kind: 'idle' }).kind).toBe('permission');
  });
});
