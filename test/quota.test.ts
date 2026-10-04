import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { quotaFor, quotaPatterns } from '../src/profiles/profile.ts';
import { figuresOf } from '../src/profiles/quota.ts';
import { readScreen } from '../src/watch/screen.ts';
import { YamlError } from '../src/yaml.ts';

const weekly = `Context 98% left · weekly 39% left`;

describe('quota patterns', () => {
  test('codex reads a full weekly line, and a cut capture is not a figure', () => {
    const patterns = quotaFor('codex');
    expect(patterns).toHaveLength(1);
    expect(figuresOf(patterns, weekly)).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
    const cut = readFileSync(new URL('./fixtures/codex/0.157.0/exit-typed.txt', import.meta.url), 'utf8');
    expect(cut).toContain('weekly 1…');
    expect(figuresOf(patterns, cut)).toEqual([]);
    expect(readScreen('codex', cut).kind).toBe('unsent');
  });

  test('the other shipped CLIs have no quota pattern', () => {
    expect(quotaFor('claude-code')).toEqual([]);
    expect(quotaFor('cursor')).toEqual([]);
    expect(quotaFor('antigravity')).toEqual([]);
  });

  test('used and a reset duration, and a figure over 100 is absent', () => {
    const patterns = quotaPatterns(`
- account: anthropic
  match: '\\bL: ([0-9]+)% \\(([0-9hm]+)\\)'
  used: '{1}%'
  resets: '{2}'
  window: session
`);
    expect(figuresOf(patterns, 'L: 13% (44m) · W: 20%')).toEqual([
      { account: 'anthropic', window: 'session', left: 87, used: 13, resets: '44m' },
    ]);
    expect(figuresOf(patterns, 'L: 101% (1m)')).toEqual([]);
  });

  test('a pattern needs exactly one of left and used', () => {
    const both = `
- account: openai
  match: '\\bweekly ([0-9]+)% left\\b'
  left: '{1}%'
  used: '{1}%'
  window: weekly
`;
    const neither = `
- account: openai
  match: '\\bweekly ([0-9]+)% left\\b'
  window: weekly
`;
    expect(() => quotaPatterns(both)).toThrow(YamlError);
    expect(() => quotaPatterns(neither)).toThrow(YamlError);
  });
});
