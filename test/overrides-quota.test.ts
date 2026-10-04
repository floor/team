import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { figuresOf } from '../src/profiles/quota.ts';
import { quotaFor } from '../src/profiles/profile.ts';
import { parseOverrides, quotaWith } from '../src/profiles/overrides.ts';
import { readScreen, statusRow } from '../src/watch/screen.ts';

const screen = readFileSync(new URL('./fixtures/codex/0.157.0/owner-status.txt', import.meta.url), 'utf8');

const OVERRIDE = `format: 1
profiles:
  codex:
    quota:
      - account: anthropic
        match: '\\bL: ([0-9]+)% \\(([0-9hm]+)\\)'
        used: '{1}%'
        resets: '{2}'
        window: session
      - account: anthropic
        match: '\\bW: ([0-9]+)% (?:\\([^)]*\\) )?\\(([0-9hm]+)\\)'
        used: '{1}%'
        resets: '{2}'
        window: weekly
`;

describe('the owner status line', () => {
  test('reads session and weekly figures only through the override', () => {
    expect(readScreen('codex', screen).kind).toBe('idle');
    const row = statusRow('codex', screen);
    expect(row).toContain('L: 13% (44m)');
    expect(row).toContain('W: 20% (+12.1%) (114h4m)');
    expect(figuresOf(quotaFor('codex'), row)).toEqual([]);
    const parsed = parseOverrides(OVERRIDE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(figuresOf(quotaWith('codex', parsed.profiles), row)).toEqual([
      { account: 'anthropic', window: 'session', left: 87, used: 13, resets: '44m' },
      { account: 'anthropic', window: 'weekly', left: 80, used: 20, resets: '114h4m' },
    ]);
  });
});
