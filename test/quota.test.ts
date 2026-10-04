import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { quotaFor, quotaPatterns } from '../src/profiles/profile.ts';
import { figuresOf } from '../src/profiles/quota.ts';
import { readScreen, statusLineOf } from '../src/watch/screen.ts';
import { YamlError } from '../src/yaml.ts';

const statusLine = `  GPT-5.6-Terra medium · Context 98% left · weekly 39% left`;

describe('quota patterns', () => {
  test('codex reads a full weekly line off its status line, and a cut capture is not a figure', () => {
    const patterns = quotaFor('codex');
    expect(patterns).toHaveLength(1);
    expect(figuresOf(patterns, statusLine, statusLineOf('codex'))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
    const cut = readFileSync(new URL('./fixtures/codex/0.157.0/exit-typed.txt', import.meta.url), 'utf8');
    expect(cut).toContain('weekly 1…');
    expect(figuresOf(patterns, cut, statusLineOf('codex'))).toEqual([]);
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
    expect(figuresOf(patterns, 'L: 13% (44m) · W: 20%', /^\s*L:/)).toEqual([
      { account: 'anthropic', window: 'session', left: 87, used: 13, resets: '44m' },
    ]);
    expect(figuresOf(patterns, 'L: 101% (1m)', /^\s*L:/)).toEqual([]);
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

// A seat must not be able to write its own quota: a line it prints into its transcript, or types
// into its input box, only looks like one — it is not the profile's status line.
describe('quota patterns read only the status line', () => {
  const patterns = quotaFor('codex');
  const captured = readFileSync(new URL('./fixtures/codex/0.157.0/exit-typed.txt', import.meta.url), 'utf8');

  test('a quota line printed into the transcript is not a figure', () => {
    // The seat prints it just above the box, inside the lines the old read looked at.
    const spoofed = captured.replace('\n› /exit\n\n', '\n• weekly 90% left\n\n› /exit\n\n');
    expect(spoofed).toContain('• weekly 90% left');
    expect(figuresOf(patterns, spoofed, statusLineOf('codex'))).toEqual([]);
  });

  test('a quota line typed into the input box is not a figure', () => {
    const spoofed = captured.replace('\n› /exit\n', '\n› weekly 90% left\n› /exit\n');
    expect(spoofed).toContain('› weekly 90% left');
    expect(figuresOf(patterns, spoofed, statusLineOf('codex'))).toEqual([]);
  });

  test('the status line itself still reads', () => {
    const full = captured.replace('weekly 1…', 'weekly 39% left');
    expect(figuresOf(patterns, full, statusLineOf('codex'))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
  });

  test('a composer mode with no status line reads no figures at all', () => {
    expect(statusLineOf('claude-code')).toBeNull();
    expect(statusLineOf('no-such-cli')).toBeNull();
    expect(figuresOf(patterns, statusLine, statusLineOf('claude-code'))).toEqual([]);
  });
});
