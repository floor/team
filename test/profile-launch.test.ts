import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../src/profiles/index.ts';
import { exitClearKey, launchCommand } from '../src/profiles/profile.ts';
import { runningModel } from '../src/status/statusline.ts';

// Main's launch readers, copied here. The production files no longer have this code.
const FAMILIES: Record<string, string> = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku', fable: 'Claude Fable' };

function mainClaude(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)--model[= ]claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?=\s|$)/.exec(launch);
  if (!match) return null;
  const [, family = '', major = '', minor] = match;
  const model = FAMILIES[family];
  if (!model) return null;
  return { model, version: minor === undefined ? major : `${major}.${minor}` };
}

function mainCodexId(id: string): { model: string; version: string } | null {
  const match = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|luna|terra)$/i.exec(id);
  if (!match) return null;
  const family = match[2] as string;
  return { model: `GPT ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] as string };
}

function mainCodex(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)(?:-m|--model)[= ]([^\s]+)(?=\s|$)/.exec(launch);
  return match ? mainCodexId(match[1] as string) : null;
}

function mainCursorId(id: string): { model: string; version: string } | null {
  const match = /^(?:cursor-)?grok-(\d+(?:\.\d+)*)(?:-(?:xhigh|high|medium|low)(?:-fast)?|-fast)?$/i.exec(id);
  const version = match?.[1];
  return version ? { model: 'Grok', version } : null;
}

function mainCursor(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)--model(?:=|\s+)(\S+)/.exec(launch);
  const id = match?.[1];
  return id ? mainCursorId(id) : null;
}

function mainAgyId(id: string): { model: string; version: string } | null {
  const match = /^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-(high|medium|low))?$/i.exec(id);
  if (!match) return null;
  const family = match[2] as string;
  return { model: `Gemini ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] as string };
}

function mainAgy(launch: string): { model: string; version: string } | null {
  const match = /(?:^|\s)--model[= ]([^\s]+)(?=\s|$)/.exec(launch);
  return match ? mainAgyId(match[1] as string) : null;
}

function mainRunning(cli: string, screen: string): { model: string; version: string } | null {
  const lines = screen.split('\n').slice(-6);
  if (cli === 'antigravity') {
    let found: { model: string; version: string } | null = null;
    for (const line of lines) {
      const match = /(?:^|[\s·|])Gemini\s+([0-9]+(?:\.[0-9]+)*)\s+(Flash|Pro)\b/i.exec(line);
      if (match && match[1] && match[2]) {
        const family = match[2];
        found = { model: `Gemini ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] };
      }
    }
    return found;
  }
  if (cli === 'cursor') {
    let found: { model: string; version: string } | null = null;
    for (const line of lines) {
      const version = /(?:^|\s)Grok\s+(\d+(?:\.\d+)*)\b/.exec(line)?.[1];
      if (version) found = { model: 'Grok', version };
    }
    return found;
  }
  if (cli === 'codex') {
    const footer = lines.findLast((line) => /^\s+GPT-\d[\w.-]*\s+[^·]*·/.test(line));
    const id = footer?.trim().split(/\s/)[0];
    return id ? mainCodexId(id) : null;
  }
  let found: { model: string; version: string } | null = null;
  for (const line of lines) {
    const match = /(?:^|[\s·|])(Opus|Sonnet|Haiku|Fable)\s+([0-9]+(?:\.[0-9]+)*)(?=$|[\s·|])/.exec(line);
    if (match) found = { model: `Claude ${match[1]}`, version: match[2] as string };
  }
  return found;
}

const launches: [string, string, (launch: string) => { model: string; version: string } | null][] = [
  ['claude-code', 'claude --model claude-opus-5-5', mainClaude],
  ['claude-code', 'claude --model=claude-fable-5-1 --verbose', mainClaude],
  ['claude-code', 'claude --model claude-haiku-4-5-20251001', mainClaude],
  ['claude-code', 'claude --model claude-opus-5', mainClaude],
  ['claude-code', 'team-deepseek', mainClaude],
  ['claude-code', 'claude --model claude-nova-9-1', mainClaude],
  ['claude-code', 'claude --model opus', mainClaude],
  ['codex', 'codex -m gpt-6-sol -c model_reasoning_effort=high', mainCodex],
  ['codex', 'codex --model=gpt-5.6-terra', mainCodex],
  ['codex', 'codex -m unknown', mainCodex],
  ['codex', 'launcher', mainCodex],
  ['cursor', 'cursor-agent --model grok-4.7-high', mainCursor],
  ['cursor', 'cursor-agent --model=grok-4.7-xhigh-fast', mainCursor],
  ['cursor', 'cursor-agent --model cursor-grok-4.5-high', mainCursor],
  ['cursor', 'cursor-agent --model cursor-grok-4.6-high-fast', mainCursor],
  ['cursor', 'cursor-agent --model grok-4.7', mainCursor],
  ['cursor', 'cursor-agent --model grok-4.7-high[context=256k]', mainCursor],
  ['cursor', 'cursor-agent --model gpt-5', mainCursor],
  ['cursor', 'cursor-agent', mainCursor],
  ['antigravity', 'agy --model gemini-3.8-flash-high', mainAgy],
  ['antigravity', 'agy --model=gemini-3.1-pro-low', mainAgy],
  ['antigravity', 'agy --model gemini-3.8-flash-medium', mainAgy],
  ['antigravity', 'agy --model gemini-3.7-flash-high', mainAgy],
  ['antigravity', 'agy --model unknown-model', mainAgy],
  ['antigravity', 'agy', mainAgy],
  ['claude-code', 'claude --model foo --model claude-opus-5-5', mainClaude],
];

// Main read null, or the first flag. The new reader keeps "=" or any whitespace, and the last flag.
const differences: [string, string, (launch: string) => { model: string; version: string } | null, { model: string; version: string } | null, { model: string; version: string } | null][] = [
  ['claude-code', 'claude --model  claude-opus-5-5', mainClaude, null, { model: 'Claude Opus', version: '5.5' }],
  ['claude-code', 'claude --model\tclaude-opus-5-5', mainClaude, null, { model: 'Claude Opus', version: '5.5' }],
  ['codex', 'codex -m  gpt-6-sol', mainCodex, null, { model: 'GPT Sol', version: '6' }],
  ['antigravity', 'agy --model  gemini-3.8-flash', mainAgy, null, { model: 'Gemini Flash', version: '3.8' }],
  ['codex', 'codex -m gpt-6-sol -m gpt-5.6-terra', mainCodex, { model: 'GPT Sol', version: '6' }, { model: 'GPT Terra', version: '5.6' }],
  ['cursor', 'cursor-agent --model grok-4.7 --model grok-4.5', mainCursor, { model: 'Grok', version: '4.7' }, { model: 'Grok', version: '4.5' }],
  ['antigravity', 'agy --model gemini-3.8-flash-high --model gemini-3.1-pro-low', mainAgy, { model: 'Gemini Flash', version: '3.8' }, { model: 'Gemini Pro', version: '3.1' }],
  ['claude-code', 'claude --model claude-opus-5-5 --model claude-sonnet-4-6', mainClaude, { model: 'Claude Opus', version: '5.5' }, { model: 'Claude Sonnet', version: '4.6' }],
];

const commands: [string, string, string, string][] = [
  ['claude-code', 'claude --model claude-opus-5-5 ', "Don't stop.\n- two", "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt 'Don'\\''t stop.\n- two'"],
  ['codex', 'codex -m gpt-6-sol', 'Rules.', 'AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-daemon --no-alt-screen'],
  ['cursor', 'cursor-agent', 'Rules.', 'AGENT_UNATTENDED=1 cursor-agent --force --sandbox disabled'],
  ['cursor', 'cursor-agent --model grok-4.7-high', 'Rules.', 'AGENT_UNATTENDED=1 cursor-agent --model grok-4.7-high --force --sandbox disabled'],
  ['antigravity', 'agy --model gemini-3.8-flash-high', 'Rules.', 'AGENT_UNATTENDED=1 agy --model gemini-3.8-flash-high --dangerously-skip-permissions'],
];

const screens: [string, string, string][] = [
  ['codex', 'codex/0.157.0/idle.txt', 'model'],
  ['codex', 'codex/0.157.0/trust.txt', 'none'],
  ['cursor', 'cursor/2026.10.01/idle.txt', 'model'],
  ['cursor', 'cursor/2026.10.01/rules-accepted.txt', 'model'],
  ['cursor', 'cursor/2026.10.01/trust.txt', 'none'],
  ['cursor', 'cursor/2026.10.01/exit.txt', 'none'],
  ['antigravity', 'antigravity/1.2.16/idle.txt', 'model'],
  ['antigravity', 'antigravity/1.2.16/rules-accepted.txt', 'model'],
  ['antigravity', 'antigravity/1.2.16/trust.txt', 'none'],
];

function same(label: string, after: unknown, before: unknown): void {
  expect(`${label}: ${JSON.stringify(after)}`).toBe(`${label}: ${JSON.stringify(before)}`);
}

describe('launch data through the profile files', () => {
  test('every launch the tests build matches main', () => {
    for (const [cli, launch, read] of launches) {
      const profile = profileFor(cli);
      same(`${cli} ${launch}`, profile?.modelOf(launch) ?? null, read(launch));
    }
    for (const [cli, launch, rules, expected] of commands) {
      const profile = profileFor(cli);
      if (!profile) throw new Error(cli);
      same(`${cli} command`, launchCommand(profile, launch, rules), expected);
    }
    const claudeScreen = `❯\n${'─'.repeat(40)}\n  main · …/floor/docs · Opus 5.5 · S: $5.8\n`;
    same('claude-code status', runningModel('claude-code', claudeScreen), mainRunning('claude-code', claudeScreen));
    same('claude-code bare', runningModel('claude-code', 'Do you want to proceed?\n1. Yes\n'), null);
    same('codex prose', runningModel('codex', 'GPT-6-Sol high'), null);
    const nova = '  GPT-9-Nova medium ·\n';
    same('codex unknown family', runningModel('codex', nova), mainRunning('codex', nova));
    const later = '  GPT-5.6-Terra medium ·\n  GPT-9-Nova medium ·\n';
    same('codex later unknown family', runningModel('codex', later), mainRunning('codex', later));
    for (const [cli, file] of screens) {
      const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
      same(`${cli} ${file}`, runningModel(cli, text), mainRunning(cli, text));
    }
  });

  test('the accepted modelOf differences', () => {
    for (const [cli, launch, read, before, after] of differences) {
      const profile = profileFor(cli);
      same(`${launch} on main`, read(launch), before);
      same(`${launch} now`, profile?.modelOf(launch) ?? null, after);
    }
  });
});

describe('the exit_clear a profile may name', () => {
  // One of the keys `pane send-keys` takes that empty an input box, or nothing. `enter` is
  // not among them on purpose: it sends what the box holds.
  test('one of the closed set, or absent for null', () => {
    expect(exitClearKey('exit: /exit')).toBe(null);
    expect(exitClearKey('exit: /exit\nexit_clear: ctrl+c')).toBe('ctrl+c');
    expect(exitClearKey('exit: /exit\nexit_clear: ctrl+u')).toBe('ctrl+u');
    expect(exitClearKey('exit: /exit\nexit_clear: escape')).toBe('escape');
    expect(exitClearKey('exit: /exit\nexit_clear: backspace')).toBe('backspace');
  });

  test('any other value is refused in words — enter included', () => {
    expect(() => exitClearKey('exit: /exit\nexit_clear: enter')).toThrow(
      '"exit_clear" must be one of: ctrl+c, ctrl+u, escape, backspace',
    );
    expect(() => exitClearKey('exit: /exit\nexit_clear: C-c')).toThrow(
      '"exit_clear" must be one of: ctrl+c, ctrl+u, escape, backspace',
    );
  });
});
