import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { antigravityComposer } from '../src/profiles/antigravity-screen.ts';
import { codexComposer } from '../src/profiles/codex-screen.ts';
import { cursorComposer } from '../src/profiles/cursor-screen.ts';
import type { Screen } from '../src/watch/screen.ts';
import { classify, classifyComposer, readScreen } from '../src/watch/screen.ts';
import { DialectError, compilePattern } from '../src/watch/dialect.ts';
import { classifyLines, composeLines } from '../src/watch/screen-core.ts';
import type { ScreenData } from '../src/watch/screen-data.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { YamlError } from '../src/yaml.ts';

// The classifier claude-code had on main, copied here so the table proves the new
// path agrees with it. The production file no longer has this code.
function mainClaude(lines: string[]): Screen['kind'] {
  const question = (line: string) =>
    /Do you trust (?:this|the) folder\?/i.test(line) || /one you trust\?/i.test(line);
  const choice = (line: string) => /^\s*[❯›>]?\s*1\.\s+Yes\b/.test(line);
  if (lines.some(question) && lines.some(choice)) return 'trust';
  const text = lines.join('\n');
  if (/Do you want to (proceed|make this edit|create|allow)|\bEsc to cancel\b.*\bTab to amend\b|^\s*❯?\s*[0-9]\. (Yes|No)\b/m.test(text)) {
    return 'permission';
  }
  if (/Enter to select|↑\/↓ to navigate|Enter to confirm|Esc to cancel/.test(text)) return 'question';
  if (/\besc to interrupt\b/.test(text) || /^[^\S\n]*[✢✳✶✻✼✽][^\n]*…\s*\(\s*\d/m.test(text)) return 'working';
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯›>]/.test(lines[i] as string)) { at = i; break; }
  }
  if (at < 0) return 'unknown';
  const typed = (lines[at] as string).replace(/^\s*[❯›>]/, '').trim();
  for (let i = at + 1; i < lines.length && !/^\s*[─━]{8,}/.test(lines[i] as string); i++) {
    if ((lines[i] as string).trim()) return 'unsent';
  }
  return typed === '' || typed.startsWith('Try "') ? 'idle' : 'unsent';
}

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const fixtures: [string, string][] = [
  ['idle', `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['suggestion', `${RULE}\n❯ Try "fix the failing test"\n${RULE}\n${STATUS}\n`],
  ['unsent', `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`],
  ['permission', `Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`],
  ['trust', `Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel`],
  ['live trust', ['Accessing workspace:', 'Quick safety check: Is this a project you created or one you trust?', 'Claude Code will be able to read, edit, and execute files here.', '❯ 1. Yes, I trust this folder', '  2. No, exit'].join('\n')],
  ['quoted trust', `The note says to trust this folder before you start.\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['question', `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`],
  ['second line', `${RULE}\n❯ \n  and a second line\n${RULE}\n${STATUS}\n`],
  ['empty box', `${RULE}\n❯ \n\n${RULE}\n${STATUS}\n`],
  ['no prompt', 'Welcome back!\n\nUpdate available: run claude update\n'],
  ['spinner', `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['interrupt', `${RULE}\n❯ \n${RULE}\n  main · Opus 5.5 · esc to interrupt\n`],
  ['finished', `✻ Churned for 51s · done 9:51 PM\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['typed list', `${RULE}\n❯ 1. fix the bug\n${RULE}\n${STATUS}\n`],
  ['lowercase choice', `Do you trust this folder?\n❯ 1. yes, proceed\n  2. No\n`],
  ['lowercase question', `do you trust the folder?\n❯ 1. Yes\n`],
];

describe('claude-code through the screen core', () => {
  test('every fixture matches the classifier main had', () => {
    for (const [name, text] of fixtures) {
      const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
      const before = mainClaude(lines);
      const after = readScreen('claude-code', text).kind;
      expect(`${name}: ${after}`).toBe(`${name}: ${before}`);
    }
  });

  test('an empty box stays idle for the composer while a turn is still on screen', () => {
    const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(classify('claude-code', busy.split('\n')).kind).toBe('working');
    expect(classifyComposer('claude-code', busy.split('\n')).kind).toBe('idle');
  });
});

const codexData = loadScreen(`
format: 1
cli: codex
screen:
  composer:
    mode: status-last
    status_line: '^\\s+GPT-[0-9][\\w.-]*\\s+[^·]*·'
    prompt: '^\\s*›(?:\\s|$)'
    placeholders:
      - equals: Ask Codex to do anything
`);

const cursorData = loadScreen(`
format: 1
cli: cursor
screen:
  composer:
    mode: status-then-one
    status_line: '^\\s+Grok\\s+[0-9]'
    prompt: '^\\s*→'
    strip_suffix: '\\s*ctrl\\+c to stop\\s*$'
    placeholders:
      - equals: Plan, search, build anything
      - equals: Add a follow-up
    fallback:
      - all:
          - match: '^\\s*→\\s+\\S'
            except: ['\\sExit\\s*$']
          - '^\\s*→?\\s*/\\S+\\s+Exit\\s*$'
        kind: unsent
`);

const agyData = loadScreen(`
format: 1
cli: antigravity
screen:
  chrome:
    - '^\\s*↑/↓ Navigate.*$'
    - '^esc to cancel\\s+Gemini\\s+[0-9].*$'
  composer:
    mode: two-rules-footer-below
    ignore_case: true
    prompt: '^\\s*>\\s*'
    rule: '^\\s*[─━]{8,}\\s*$'
    footers:
      - '\\? for shortcuts'
      - 'Gemini\\s+[0-9]'
      - 'esc to cancel'
      - '>\\s*/exit\\s+Exit'
    placeholders:
      - equals: ''
`);

function window(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd()).slice(-20);
}

function sameComposer(name: string, data: ScreenData, read: (lines: string[]) => Screen, dir: string, version: string, files: string[]): void {
  for (const file of files) {
    const lines = window(readFileSync(new URL(`./fixtures/${dir}/${version}/${file}.txt`, import.meta.url), 'utf8'));
    const before = read(lines).kind;
    if (before === 'trust' || before === 'permission' || before === 'question') continue;
    expect(`${name} ${file}: ${composeLines(data, lines).kind}`).toBe(`${name} ${file}: ${before}`);
  }
}

describe('the other three composer modes', () => {
  test('they agree with the code they will replace, on screens that are not dialogs', () => {
    sameComposer('codex', codexData, codexComposer, 'codex', '0.157.0', ['idle', 'unsent', 'exit', 'exit-typed', 'working', 'startup', 'rules-accepted']);
    sameComposer('cursor', cursorData, cursorComposer, 'cursor', '2026.10.01', ['idle', 'unsent', 'exit-typed', 'working', 'thinking', 'startup', 'rules-accepted']);
    sameComposer('antigravity', agyData, antigravityComposer, 'antigravity', '1.2.16', ['idle', 'unsent', 'exit', 'exit-typed', 'working', 'rules-accepted']);
  });
});

describe('the pattern dialect', () => {
  test('shorthand classes match JavaScript, and the nested shapes are refused', () => {
    const ours = compilePattern('^\\s$');
    const native = /^\s$/u;
    let mismatches = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (ours.test(ch) !== native.test(ch)) mismatches++;
    }
    expect(mismatches).toBe(0);
    const gap = compilePattern('^[^\\S\\n]$');
    const nativeGap = /^[^\S\n]$/;
    for (const cp of [0x09, 0x0a, 0x20, 0x41]) expect(gap.test(String.fromCodePoint(cp))).toBe(nativeGap.test(String.fromCodePoint(cp)));
    expect(() => compilePattern('(a+)+')).toThrow(DialectError);
    expect(() => compilePattern('(.+)*')).toThrow(DialectError);
    expect(() => compilePattern('(\\.?[0-9]+)*')).toThrow(DialectError);
    expect(() => compilePattern('(?=a)')).toThrow(DialectError);
    expect(() => compilePattern('\\u0041')).toThrow(DialectError);
    expect(() => compilePattern('a'.repeat(201))).toThrow(DialectError);
    expect(compilePattern('([0-9]+(?:\\.[0-9]+)*)').test('1.2.3')).toBe(true);
    expect(compilePattern('(a|aa)*').test('aaaa')).toBe(true);
  });

  test('a read that passes the time bound is unknown', () => {
    const data = loadScreen(`
format: 1
cli: sample
screen:
  trust:
    - all: ['alpha', 'beta']
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`);
    const lines = ['alpha', 'beta'];
    expect(classifyLines(data, lines).kind).toBe('trust');
    let calls = 0;
    const clock = { budgetMs: 100, now: () => (calls++ < 2 ? 0 : 1_000) };
    expect(classifyLines(data, lines, clock).kind).toBe('unknown');
  });

  test('chrome that would hide a numbered choice is refused', () => {
    const text = `
format: 1
cli: sample
screen:
  chrome: ['^.*$']
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;
    expect(() => loadScreen(text)).toThrow(YamlError);
  });
});
