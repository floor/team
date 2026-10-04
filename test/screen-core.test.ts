import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Screen } from '../src/watch/screen.ts';
import { classify, classifyComposer, readScreen } from '../src/watch/screen.ts';
import { DialectError, compilePattern } from '../src/watch/dialect.ts';
import { classifyLines } from '../src/watch/screen-core.ts';
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
  ['quoted permission', `The last answer asks: Do you want to proceed?\n1. Yes, if the tests pass\n2. No\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
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
      if (name === 'quoted permission') continue;
      const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
      const before = mainClaude(lines);
      const after = readScreen('claude-code', text).kind;
      const named = classify('claude-code', text.split('\n')).kind;
      expect(`${name}: ${after}`).toBe(`${name}: ${before}`);
      expect(`${name}: ${named}`).toBe(`${name}: ${before}`);
    }
  });

  test('a quoted permission question above an empty box is the one difference', () => {
    const text = fixtures.find(([name]) => name === 'quoted permission')?.[1] ?? '';
    const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(mainClaude(lines)).toBe('permission');
    expect(readScreen('claude-code', text).kind).toBe('idle');
  });

  test('an empty box stays idle for the composer while a turn is still on screen', () => {
    const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(classify('claude-code', busy.split('\n')).kind).toBe('working');
    expect(classifyComposer('claude-code', busy.split('\n')).kind).toBe('idle');
  });
});

// The classifiers codex, cursor and antigravity had on main, copied here so the
// table proves the new path agrees with them. The production files are gone.
function mainCodex(lines: string[]): Screen['kind'] {
  if (lines.some((line) => /\bmodel:\s+loading\b/.test(line))) return 'unknown';
  const composer = codexBox(lines);
  if (composer === 'permission' || composer === 'trust' || composer === 'question') return composer;
  if (lines.some((line) => /esc to interrupt/.test(line))) return 'working';
  return composer;
}

function codexBox(lines: string[]): Screen['kind'] {
  const text = lines.join('\n');
  const last = lines.filter((line) => line.trim()).at(-1)?.trim() ?? '';
  if (last === 'Press enter to confirm or esc to cancel'
    && /^\s*Would you like to run the following command\?\s*$/m.test(text)
    && /^\s*›?\s*1\. Yes, proceed \(y\)\s*$/m.test(text)
    && /^\s*›?\s*2\. No, and tell Codex what to do differently \(esc\)\s*$/m.test(text)) return 'permission';
  if (last === 'enter continue · esc quit' && /Trust this folder\?/.test(text)
    && /^\s*›?\s*1\. Trust and continue\s*$/m.test(text)) return 'trust';
  if (last === 'enter continue · esc skip' && /Update available ·/.test(text)
    && /^\s*›?\s*1\. Update now\b/m.test(text)) return 'question';
  const footer = lines.findLastIndex((line) => /^\s+GPT-\d[\w.-]*\s+[^·]*·/.test(line));
  if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return 'unknown';
  let prompt = footer - 1;
  while (prompt >= 0 && !/^\s*›(?:\s|$)/.test(lines[prompt] as string)) prompt--;
  if (prompt < 0) return 'unknown';
  const typed = (lines[prompt] as string).replace(/^\s*›/, '').trim();
  if (lines.slice(prompt + 1, footer).some((line) => line.trim())) return 'unsent';
  return typed === '' || typed === 'Ask Codex to do anything' ? 'idle' : 'unsent';
}

function mainCursor(lines: string[]): Screen['kind'] {
  const composer = cursorBox(lines);
  if (composer === 'trust') return composer;
  if (lines.some((line) => /ctrl\+c to stop/.test(line) || /^\s*[\u2800-\u28FF]+\s+(Working|Thinking)\b/.test(line))) return 'working';
  return composer;
}

function cursorBox(lines: string[]): Screen['kind'] {
  if (cursorTrust(lines)) return 'trust';
  if (lines.some((line) => /To resume this session:/.test(line))) return 'unknown';
  const footer = lines.findLastIndex((line) => /^\s+Grok\s+\d/.test(line));
  if (footer < 0) return cursorSlash(lines);
  const trailing = lines.slice(footer + 1).filter((line) => line.trim());
  if (trailing.length > 1 || trailing.some((line) => /^\s*→/.test(line))) return 'unknown';
  let prompt = footer - 1;
  while (prompt >= 0 && !/^\s*→/.test(lines[prompt] ?? '')) prompt--;
  if (prompt < 0) return 'unknown';
  const typed = (lines[prompt] ?? '').replace(/^\s*→/, '').replace(/\s*ctrl\+c to stop\s*$/, '').trim();
  if (lines.slice(prompt + 1, footer).some((line) => line.trim())) return 'unsent';
  return typed === '' || typed === 'Plan, search, build anything' || typed === 'Add a follow-up' ? 'idle' : 'unsent';
}

function cursorTrust(lines: string[]): boolean {
  const text = lines.join('\n');
  if (!/Do you trust the contents of this/.test(text) || !/directory\?/.test(text)) return false;
  if (!/\[a\] Trust this workspace/.test(text) || !/\[q\] Quit/.test(text)) return false;
  const nav = lines.findLastIndex((line) => /Use arrow keys to navigate, Enter to/.test(line));
  if (nav < 0) return false;
  return !lines.slice(nav + 1).some((line) => /^\s*→/.test(line) || /^\s+Grok\s+\d/.test(line));
}

function cursorSlash(lines: string[]): Screen['kind'] {
  const typed = lines.findIndex((line) => /^\s*→\s+\S/.test(line) && !/\sExit\s*$/.test(line));
  const menu = lines.some((line) => /^\s*→?\s*\/\S+\s+Exit\s*$/.test(line));
  return typed >= 0 && menu ? 'unsent' : 'unknown';
}

function mainAntigravity(lines: string[]): Screen['kind'] {
  const composer = agyBox(lines);
  if (composer === 'trust' || composer === 'permission') return composer;
  if (lines.some((line) => /\bGenerating\.\.\./.test(line))) return 'working';
  return composer;
}

function agyBox(lines: string[]): Screen['kind'] {
  const text = lines.join('\n');
  const hasTrustQuestion = /Do you trust the contents of this project\?/i.test(text);
  const hasTrustChoice = />\s*Yes, I trust this folder/i.test(text);
  const hasConfirmFooter = lines.some((line) => /enter Confirm/i.test(line));
  if (hasTrustQuestion && hasTrustChoice && hasConfirmFooter) {
    const lastRule = lines.findLastIndex((line) => /^\s*[─━]{8,}\s*$/.test(line));
    const confirmIdx = lines.findLastIndex((line) => /enter Confirm/i.test(line));
    if (confirmIdx > lastRule) return 'trust';
  }
  const hasPermissionReq = /Requesting permission for:/i.test(text);
  const hasPermissionChoice = lines.some((line) => /^\s*>\s*[0-9]\.\s+Yes\b/i.test(line));
  const hasPermissionNav = lines.some((line) => /↑\/↓ Navigate/i.test(line));
  if (hasPermissionReq && hasPermissionChoice && hasPermissionNav) {
    const lastRule = lines.findLastIndex((line) => /^\s*[─━]{8,}\s*$/.test(line));
    const navIdx = lines.findLastIndex((line) => /↑\/↓ Navigate/i.test(line));
    if (navIdx > lastRule) return 'permission';
  }
  let bottomBorder = -1;
  let topBorder = -1;
  let prompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (/^\s*[─━]{8,}\s*$/.test(line)) {
      if (bottomBorder === -1) bottomBorder = i;
      else if (topBorder === -1 && prompt !== -1) { topBorder = i; break; }
    } else if (bottomBorder !== -1 && prompt === -1 && /^\s*>\s*/.test(line)) prompt = i;
  }
  if (topBorder < 0 || bottomBorder < 0 || prompt <= topBorder || prompt >= bottomBorder) return 'unknown';
  const belowBottom = lines.slice(bottomBorder + 1);
  const validFooter = belowBottom.some((line) => /(\? for shortcuts|Gemini\s+\d|esc to cancel|>\s*\/exit\s+Exit)/i.test(line));
  if (!validFooter) return 'unknown';
  const typed = (lines[prompt] as string).replace(/^\s*>\s*/, '').trim();
  if (lines.slice(prompt + 1, bottomBorder).some((line) => line.trim() !== '')) return 'unsent';
  return typed === '' ? 'idle' : 'unsent';
}

function windowOf(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd()).slice(-20);
}

const captured: [string, string, (lines: string[]) => Screen['kind']][] = [
  ['codex', '0.157.0', mainCodex],
  ['cursor', '2026.10.01', mainCursor],
  ['antigravity', '1.2.16', mainAntigravity],
];

describe('codex, cursor and antigravity through the screen core', () => {
  test('every captured screen matches the classifier main had', () => {
    for (const [cli, version, read] of captured) {
      const dir = fileURLToPath(new URL(`./fixtures/${cli}/${version}/`, import.meta.url));
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.txt')) continue;
        // Constructed, not captured (see the fixtures README), and the one screen a fix is
        // meant to read differently: main's classifier called the dialog below `unsent`, and
        // two input paths pressed Enter on that reading. Its own test follows the loop.
        if (name === 'permission-pinned.txt') continue;
        const text = readFileSync(new URL(`./fixtures/${cli}/${version}/${name}`, import.meta.url), 'utf8');
        const before = read(windowOf(text));
        const after = readScreen(cli, text).kind;
        const named = classify(cli, text.split('\n')).kind;
        expect(`${cli} ${name}: ${after}`).toBe(`${cli} ${name}: ${before}`);
        expect(`${cli} ${name}: ${named}`).toBe(`${cli} ${name}: ${before}`);
      }
    }
  });

  test('the constructed fixture differs on purpose: a permission dialog above the pinned status line', () => {
    const text = readFileSync(new URL('./fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    // Main missed the dialog twice over: its lower-case footer phrase, and the choice line read
    // as the composer's input. The new reading is the dialog, and never idle or unsent.
    expect(mainCodex(windowOf(text))).toBe('unsent');
    expect(readScreen('codex', text).kind).toBe('permission');
    expect(classify('codex', text.split('\n')).kind).toBe('permission');
  });

  test('the one difference: cursor reads a resume line before a trust dialog', () => {
    const trust = readFileSync(new URL('./fixtures/cursor/2026.10.01/trust.txt', import.meta.url), 'utf8');
    const both = `${trust}\nTo resume this session:\n`;
    expect(mainCursor(windowOf(both))).toBe('trust');
    expect(readScreen('cursor', both).kind).toBe('unknown');
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
