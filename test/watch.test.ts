import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch } from '../src/commands/watch.ts';
import type { WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { parseMeminfo, parseMemoryPressure, parseSwapUsage, readMachine } from '../src/watch/machine.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, NUDGE_TEXT, pass } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`).replace('  seats: 6', '  seats: 8');

// The example's codex-acme is parked. The neutral scene unparks it, so the parked rules (and
// their notice) are in play only where a test asks for them with parkedTeam.
const unparked = example.replace('    parked: true\n', '');

function parse(source: string): TeamFile {
  const result = validateTeamFile(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function team(): TeamFile {
  return parse(unparked);
}

function parkedTeam(): TeamFile {
  return parse(example);
}

// Screens of Claude Code, as the live team shows them.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const suggestion = `${RULE}\n❯ Try "fix the failing test"\n${RULE}\n${STATUS}\n`;
const unsent = `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`;
const permission = `Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`;
const question = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
// The captured screen names Terra; the example's codex-acme is GPT Sol 6. Read with the seat's own
// id, this screen is here for its unsent composer alone, with no model mismatch of its own.
const codexUnsent = readFileSync(new URL('./fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8')
  .replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');

describe('reading a screen of Claude Code', () => {
  test('an empty idle prompt, with or without a greyed suggestion', () => {
    expect(readScreen('claude-code', idle).kind).toBe('idle');
    expect(readScreen('claude-code', suggestion).kind).toBe('idle');
  });
  test('text left in the input box', () => {
    expect(readScreen('claude-code', unsent).kind).toBe('unsent');
  });
  test('a permission prompt is told apart from a question', () => {
    expect(readScreen('claude-code', permission).kind).toBe('permission');
    const agyPermission = readFileSync(new URL('./fixtures/antigravity/1.2.16/permission.txt', import.meta.url), 'utf8');
    expect(readScreen('antigravity', agyPermission).kind).toBe('permission');
    expect(readScreen('claude-code', `Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel`).kind).toBe('trust');
    const liveTrust = [
      'Accessing workspace:',
      'Quick safety check: Is this a project you created or one you trust?',
      'Claude Code will be able to read, edit, and execute files here.',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
    ].join('\n');
    expect(readScreen('claude-code', liveTrust).kind).toBe('trust');
    const quoted = `The note says to trust this folder before you start.\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', quoted).kind).toBe('idle');
    expect(readScreen('claude-code', question).kind).toBe('question');
  });
  test('text on a later line of the box, under an empty first line, is unsent text', () => {
    expect(readScreen('claude-code', `${RULE}\n❯ \n  and a second line\n${RULE}\n${STATUS}\n`).kind).toBe('unsent');
    expect(readScreen('claude-code', `${RULE}\n❯ \n\n${RULE}\n${STATUS}\n`).kind).toBe('idle');
  });
  test('anything else is unknown: a screen without a prompt, no screen, another CLI', () => {
    expect(readScreen('claude-code', 'Welcome back!\n\nUpdate available: run claude update\n').kind).toBe('unknown');
    expect(readScreen('claude-code', undefined).kind).toBe('unknown');
    expect(readScreen('codex', idle).kind).toBe('unknown');
  });
  test('a running turn is working, not an empty idle box; a finished one is idle again', () => {
    expect(readScreen('claude-code', busy).kind).toBe('working');
    expect(readScreen('claude-code', `${RULE}\n❯ \n${RULE}\n  main · Opus 5.5 · esc to interrupt\n`).kind).toBe('working');
    const finished = `✻ Churned for 51s · done 9:51 PM\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', finished).kind).toBe('idle');
  });
});

describe('the machine\'s figures', () => {
  test('macOS swap usage', () => {
    expect(parseSwapUsage('total = 25600.00M  used = 23981.81M  free = 1618.19M  (encrypted)')).toEqual({
      total: 25600 * 1024 ** 2, used: 23981.81 * 1024 ** 2, free: 1618.19 * 1024 ** 2,
    });
    expect(parseSwapUsage('nonsense')).toBeNull();
  });
  test('macOS memory pressure', () => {
    expect(parseMemoryPressure('…\nSystem-wide memory free percentage: 49%\n')).toBe(49);
    expect(parseMemoryPressure('')).toBeNull();
  });
  test('Linux meminfo, with and without swap', () => {
    const info = 'MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:         500000 kB\n';
    expect(parseMeminfo(info)).toEqual({ memoryFree: 25, swapFree: 500000 * 1024, swapUsed: 1500000 * 1024 });
    expect(parseMeminfo('MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')).toEqual({ memoryFree: 50, swapFree: null, swapUsed: null });
  });
  test('this machine: every figure it can read is a number', () => {
    const machine = readMachine(process.cwd());
    expect(machine.loadPerCore).toBeGreaterThanOrEqual(0);
    expect(machine.diskFree).toBeGreaterThan(0);
    for (const value of Object.values(machine)) expect(value === null || Number.isFinite(value)).toBe(true);
  });
});

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;

function agent(name: string | null, workspace: string, status: string, kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team, everyone working, the operator at an empty prompt.
function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle', idle],
    ['claude-coordinator-acme', 'w1', 'working', busy],
    ['codex-acme', 'w2', 'working', ''],
    ['deepseek-acme', 'w3', 'working', busy],
    ['deepseek-acme-2', 'w4', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, name.startsWith('codex') ? 'codex' : 'claude'));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('a pass of the watch', () => {
  test('a working team reports nothing', () => {
    expect(pass(team(), emptySession(), live(), fine, 0, newMemory())).toEqual({ reports: [], nudge: null, fallback: null });
  });

  test('an idle seat is reported after idle_first, and again every idle_repeat', () => {
    const memory = newMemory();
    const quiet = live({ 'deepseek-acme': { status: 'done', screen: idle } });
    const at = (minute: number) => pass(team(), emptySession(), quiet, fine, minute * MIN, memory).reports.map((report) => report.text);
    expect(at(0)).toEqual([]);
    expect(at(9)).toEqual([]);
    // Never seen working: the report says so instead of inventing a duration.
    expect(at(10)).toEqual(['deepseek-acme has been idle since the watch started']);
    expect(at(12)).toEqual([]);
    expect(at(29)).toEqual([]);
    expect(at(30)).toEqual(['deepseek-acme has been idle since the watch started']);
  });

  test('work resets the idle timer', () => {
    const memory = newMemory();
    const quiet = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    pass(team(), emptySession(), quiet, fine, 0, memory);
    pass(team(), emptySession(), live(), fine, 9 * MIN, memory);
    expect(pass(team(), emptySession(), quiet, fine, 10 * MIN, memory).reports).toEqual([]);
  });

  test('a parked seat found running is reported once, then watched like any running seat', () => {
    const memory = newMemory();
    const at = (scene: Live, minute: number) =>
      pass(parkedTeam(), emptySession(), scene, fine, minute * MIN, memory).reports.map((report) => report.text);
    // Parked in the file and running in herdr: said once, while that run lasts.
    expect(at(live(), 0)).toEqual(['codex-acme is parked in the file but running']);
    expect(at(live(), 5)).toEqual([]);
    // Watched like any running seat: the idle anchor counts from its last work.
    expect(at(live({ 'codex-acme': { status: 'done' } }), 15)).toEqual(['codex-acme has been idle for 10 minutes']);
    // Its unsent text is reported after unsent_after, as for any running seat.
    const holding = live({ 'codex-acme': { status: 'idle', screen: codexUnsent } });
    expect(at(holding, 17)).toEqual([]);
    expect(at(holding, 18)).toEqual(['codex-acme holds text in its input box that was never sent']);
    expect(at(live({ 'codex-acme': { status: 'blocked' } }), 19))
      .toEqual(['codex-acme is blocked, and its screen is not one the watch recognises']);
  });

  test('a parked seat that is not running stays silent, and is told again on its next run', () => {
    const memory = newMemory();
    const at = (scene: Live, minute: number) =>
      pass(parkedTeam(), emptySession(), scene, fine, minute * MIN, memory).reports.map((report) => report.text);
    expect(at(live(), 0)).toEqual(['codex-acme is parked in the file but running']);
    // Gone from herdr: silent — a parked seat is only news while it is running.
    const gone = live();
    gone.agents = gone.agents.filter((one) => one.name !== 'codex-acme');
    expect(at(gone, 10)).toEqual([]);
    // Running again is a new run: told again.
    expect(at(live(), 20)).toEqual(['codex-acme is parked in the file but running']);
  });

  test('a seat unparked in the file behaves as before', () => {
    const memory = newMemory();
    const at = (scene: Live, minute: number) =>
      pass(team(), emptySession(), scene, fine, minute * MIN, memory).reports.map((report) => report.text);
    // Unparked: no notice while it runs.
    expect(at(live(), 0)).toEqual([]);
    // Gone from herdr it is reported as any other seat.
    const gone = live();
    gone.agents = gone.agents.filter((one) => one.name !== 'codex-acme');
    expect(at(gone, 10)).toEqual(['codex-acme is in the file and is not running']);
  });

  test('a permission prompt that herdr calls idle is the owner\'s, and is never an idle seat', () => {
    const memory = newMemory();
    const stuck = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    const first = pass(team(), emptySession(), stuck, fine, 0, memory);
    expect(first.reports).toEqual([{ key: 'blocked:deepseek-acme', text: 'deepseek-acme waits at a permission prompt: its owner\'s to answer', to: 'owner' }]);
    expect(first.nudge).toBeNull();
    expect(pass(team(), emptySession(), stuck, fine, 30 * MIN, memory).reports).toEqual([]);
  });

  test.each(['idle', 'working'])('a captured Codex permission goes to its owner when herdr says %s', (status) => {
    const screen = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const memory = newMemory();
    const stuck = live({ 'codex-acme': { status, screen } });
    const first = pass(team(), emptySession(), stuck, fine, 0, memory);
    expect(first.reports).toEqual([{ key: 'blocked:codex-acme', text: "codex-acme waits at a permission prompt: its owner's to answer", to: 'owner' }]);
    expect(first.nudge).toBeNull();
    expect(pass(team(), emptySession(), stuck, fine, 30 * MIN, memory).reports).toEqual([]);
  });

  test('a question is the operator\'s', () => {
    const asked = live({ 'deepseek-acme-2': { status: 'blocked', screen: question } });
    const result = pass(team(), emptySession(), asked, fine, 0, newMemory());
    expect(result.reports).toEqual([{ key: 'question:deepseek-acme-2', text: 'deepseek-acme-2 asked a question: the operator\'s to act on', to: 'operator' }]);
  });

  test('a condition is reported once, and again only after it has cleared', () => {
    const memory = newMemory();
    const stuck = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    expect(pass(team(), emptySession(), stuck, fine, 0, memory).reports.length).toBe(1);
    expect(pass(team(), emptySession(), stuck, fine, MIN, memory).reports.length).toBe(0);
    expect(pass(team(), emptySession(), live(), fine, 2 * MIN, memory).reports.length).toBe(0);
    expect(pass(team(), emptySession(), stuck, fine, 3 * MIN, memory).reports.length).toBe(1);
  });

  test('unsent input is its own condition, after unsent_after, for the coordinator too', () => {
    const memory = newMemory();
    const typed = live({ 'claude-coordinator-acme': { status: 'idle', screen: unsent } });
    expect(pass(team(), emptySession(), typed, fine, 0, memory).reports).toEqual([]);
    expect(pass(team(), emptySession(), typed, fine, MIN, memory).reports.map((report) => report.text)).toEqual([
      'claude-coordinator-acme holds text in its input box that was never sent',
    ]);
  });

  test('a fully idle team, the coordinator and the operator left out, is reported once', () => {
    const memory = newMemory();
    const all = live({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'done', screen: idle },
    });
    // codex-acme is parked and the leads don't count: the two DeepSeek seats are the team.
    expect(pass(parkedTeam(), emptySession(), all, fine, 0, memory).reports.map((report) => report.text))
      .toEqual(['codex-acme is parked in the file but running']);
    const texts = pass(parkedTeam(), emptySession(), all, fine, 10 * MIN, memory).reports.map((report) => report.text);
    expect(texts).toContain('every agent is idle');
    expect(pass(parkedTeam(), emptySession(), all, fine, 15 * MIN, memory).reports.map((report) => report.text)).not.toContain('every agent is idle');
  });

  test('a missing seat, an agent the file doesn\'t hold, and a wrong model', () => {
    const now = live({ 'claude-coordinator-acme': { screen: busy.replace('Opus 5.5', 'Fable 5.1') } });
    now.agents = now.agents.filter((one) => one.name !== 'deepseek-acme-2');
    now.agents.push(agent('stranger', 'w8', 'working'), agent(null, 'w9', 'working'));
    now.workspaces.push({ id: 'w8', label: 'x' }, { id: 'w9', label: 'watchdog' });
    const texts = pass(team(), emptySession(), now, fine, 0, newMemory()).reports.map((report) => report.text);
    expect(texts).toEqual([
      'claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5: it signs with the wrong model',
      'deepseek-acme-2 is in the file and is not running',
      'stranger (w8:p1) is running and is not in the file',
    ]);
  });

  test('a temporary seat of the state is watched as a seat', () => {
    const state = { ...emptySession(), seats: { 'deepseek-acme-tmp-1': { stage: 'ready' as const, temporary: { like: 'deepseek-acme', until: 'result:out.md' } } } };
    const now = live();
    now.agents.push(agent('deepseek-acme-tmp-1', 'w7', 'idle'));
    now.screens['w7:p1'] = permission;
    const texts = pass(team(), state, now, fine, 0, newMemory()).reports.map((report) => report.text);
    expect(texts).toEqual(['deepseek-acme-tmp-1 waits at a permission prompt: its owner\'s to answer']);
  });

  test('a seat that runs another maker\'s model through Claude Code is unread, never wrong', () => {
    // The DeepSeek seats show Claude Code\'s status line; it names no model of theirs.
    expect(pass(team(), emptySession(), live(), fine, 0, newMemory()).reports).toEqual([]);
  });

  test('the machine: load per core, memory, disk and free swap, each against its threshold', () => {
    const tight: Machine = { loadPerCore: 6.5, memoryFree: 10, diskFree: 5e9, swapFree: 0.3e9, swapUsed: 23e9 };
    const reports = pass(team(), emptySession(), live(), tight, 0, newMemory()).reports;
    expect(reports.map((report) => report.text)).toEqual([
      'the load is 6.5 per core, above 6',
      'free memory is 10%, below 15%',
      'free disk is 5.0 GB, below 10.0 GB',
      'free swap is 0.3 GB, below 2.0 GB',
    ]);
    expect(reports.every((report) => report.to === 'owner')).toBe(true);
  });

  test('swap that grows fast is pressure even while free swap is high', () => {
    const memory = newMemory();
    const at = (minute: number, used: number) =>
      pass(team(), emptySession(), live(), { ...fine, swapUsed: used }, minute * MIN, memory).reports.map((report) => report.text);
    expect(at(0, 1e9)).toEqual([]);
    expect(at(5, 1.8e9)).toEqual([]);
    expect(at(8, 2.4e9)).toEqual(['swap grew by 1.4 GB in 10 minutes, above 1.0 GB']);
    // The same growth an hour apart is not pressure.
    const slow = newMemory();
    pass(team(), emptySession(), live(), { ...fine, swapUsed: 1e9 }, 0, slow);
    expect(pass(team(), emptySession(), live(), { ...fine, swapUsed: 2.4e9 }, 60 * MIN, slow).reports).toEqual([]);
  });

  test('a file that differs from the approved one is the owner\'s, reported once', () => {
    const memory = newMemory();
    const first = pass(team(), emptySession(), live(), fine, 0, memory, ['`rules` changed']);
    expect(first.reports).toEqual([{ key: 'approval', text: 'the file differs from the approved one: `rules` changed', to: 'owner' }]);
    expect(pass(team(), emptySession(), live(), fine, MIN, memory, ['`rules` changed']).reports).toEqual([]);
    expect(pass(team(), emptySession(), live(), fine, 0, newMemory(), null).reports[0]?.text).toBe('the file was never approved on this machine');
    expect(pass(team(), emptySession(), live(), fine, 0, newMemory(), []).reports).toEqual([]);
  });

  test('a figure that can\'t be read is never reported', () => {
    const blind: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapFree: null, swapUsed: null };
    expect(pass(team(), emptySession(), live(), blind, 0, newMemory()).reports).toEqual([]);
  });
});

// The screens each profile's CLI was captured showing, for the idle anchor cases.
const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
const codexWorking = readFileSync(new URL('./fixtures/codex/0.157.0/working.txt', import.meta.url), 'utf8');
const agyIdle = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
const agyWorking = readFileSync(new URL('./fixtures/antigravity/1.2.16/working.txt', import.meta.url), 'utf8');

// One worker per CLI profile, so the idle clock is pinned the same way for each.
const anchorExample = `
format: 1
project: anchor
workspace:
  mode: shared
coordinator: claude-lead
operator: claude-lead
seats:
  - role: coordinator
    name: claude-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: claude-worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: codex-worker
    cli: codex
    vendor: openai
    model: GPT Terra
    version: "5.6"
    launch: codex
  - role: implementer
    name: agy-worker
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
`;

function anchorTeam(): TeamFile {
  const result = validateTeamFile(anchorExample);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// Every worker working, the lead idle at its prompt, except where a case says otherwise.
function anchorScene(over: Record<string, { status?: string; screen?: string }> = {}): Live {
  const workers = ['claude-worker', 'codex-worker', 'agy-worker'];
  const agents: HerdrAgent[] = [
    { name: 'claude-lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null },
    ...workers.map((name, index) => ({
      name, agent: null, pane: `w${index + 1}:p1`, workspace: `w${index + 1}`, status: 'working', cwd: null,
    })),
  ];
  const screens: Record<string, string> = { 'w0:p1': idle, 'w1:p1': busy, 'w2:p1': codexWorking, 'w3:p1': agyWorking };
  for (const one of agents) {
    const change = over[one.name as string];
    if (!change) continue;
    if (change.status !== undefined) one.status = change.status;
    if (change.screen !== undefined) screens[one.pane] = change.screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('the idle anchor', () => {
  // One worker per CLI, with the working and idle screens this repo captured for it.
  const workers = [
    ['claude-worker', busy, idle],
    ['codex-worker', codexWorking, codexIdle],
    ['agy-worker', agyWorking, agyIdle],
  ] as const;

  const reportAt = (memory: ReturnType<typeof newMemory>, minute: number, over: Record<string, { status?: string; screen?: string }> = {}) =>
    pass(anchorTeam(), emptySession(), anchorScene(over), fine, minute * MIN, memory).reports.map((report) => report.text);

  test.each(workers)('%s: the duration counts from the last "working" observation', (name, workingScreen, idleScreen) => {
    const memory = newMemory();
    expect(reportAt(memory, 5, { [name]: { status: 'working', screen: workingScreen } })).toEqual([]);
    // Quiet from minute 5 on: the clock runs from the work, not from the first quiet pass.
    expect(reportAt(memory, 15, { [name]: { status: 'idle', screen: idleScreen } })).toEqual([`${name} has been idle for 10 minutes`]);
  });

  test.each(workers)('%s: a working screen is the observation while herdr still says idle', (name, workingScreen, idleScreen) => {
    const memory = newMemory();
    // Herdr lags the transition: its status stays idle while the screen shows the turn running.
    expect(reportAt(memory, 10, { [name]: { status: 'idle', screen: workingScreen } })).toEqual([]);
    expect(reportAt(memory, 25, { [name]: { status: 'idle', screen: workingScreen } })).toEqual([]);
    // The turn over, the seat quiet: ten minutes since the last working observation, not twenty-five.
    expect(reportAt(memory, 35, { [name]: { status: 'idle', screen: idleScreen } })).toEqual([`${name} has been idle for 10 minutes`]);
  });

  test.each(workers)('%s: never seen working, the report carries no duration', (name, _working, idleScreen) => {
    const memory = newMemory();
    const quiet = { [name]: { status: 'idle', screen: idleScreen } };
    expect(reportAt(memory, 0, quiet)).toEqual([]);
    expect(reportAt(memory, 9, quiet)).toEqual([]);
    expect(reportAt(memory, 10, quiet)).toEqual([`${name} has been idle since the watch started`]);
    expect(reportAt(memory, 30, quiet)).toEqual([`${name} has been idle since the watch started`]);
  });
});

describe('the nudge', () => {
  const asked = (operator: { status?: string; screen?: string }) =>
    live({ 'deepseek-acme-2': { status: 'blocked', screen: question }, 'claude-operator-acme': operator });

  test('is typed only for an operator at an empty idle prompt', () => {
    const result = pass(team(), emptySession(), asked({}), fine, 0, newMemory());
    expect(result.nudge).toEqual({
      pane: 'w0:p1',
      text: NUDGE_TEXT,
      pending: ['deepseek-acme-2 asked a question: the operator\'s to act on'],
    });
  });

  test('is one constant line: no report text, no digit, nothing a dialog could take as an answer', () => {
    const first = pass(team(), emptySession(), asked({}), fine, 0, newMemory()).nudge;
    const gone = live();
    gone.agents = gone.agents.filter((one) => one.name !== 'deepseek-acme-2');
    const second = pass(team(), emptySession(), gone, fine, 0, newMemory()).nudge;
    // The same line whatever the reports: the report text never travels in the nudge.
    expect(first?.text).toBe(NUDGE_TEXT);
    expect(second?.text).toBe(NUDGE_TEXT);
    expect(first?.text).not.toContain('deepseek-acme-2');
    // A dialog can open between the screen read and the typing: a digit would pick an option.
    expect(NUDGE_TEXT).not.toMatch(/[0-9]/);
    expect(NUDGE_TEXT).not.toMatch(/^[yYnN]/);
  });

  for (const [name, operator] of Object.entries({
    'mid-turn': { status: 'working', screen: busy },
    'at a permission prompt that herdr calls idle': { status: 'idle', screen: permission },
    'holding unsent text': { status: 'idle', screen: unsent },
    'with a screen the watch doesn\'t recognise': { status: 'idle', screen: 'Welcome back!' },
  })) {
    test(`waits for an operator ${name}, and is never dropped`, () => {
      const memory = newMemory();
      expect(pass(team(), emptySession(), asked(operator), fine, 0, memory).nudge).toBeNull();
      expect(memory.pending.length).toBe(1);
      const later = pass(team(), emptySession(), asked({}), fine, 5 * MIN, memory);
      expect(later.nudge?.text).toBe(NUDGE_TEXT);
      expect(later.nudge?.pending).toEqual(['deepseek-acme-2 asked a question: the operator\'s to act on']);
      expect(memory.pending).toEqual([]);
    });
  }

  test('becomes a notification after nudge_wait', () => {
    const memory = newMemory();
    const stuck = asked({ status: 'working', screen: busy });
    expect(pass(team(), emptySession(), stuck, fine, 0, memory).fallback).toBeNull();
    expect(pass(team(), emptySession(), stuck, fine, 9 * MIN, memory).fallback).toBeNull();
    const result = pass(team(), emptySession(), stuck, fine, 10 * MIN, memory);
    expect(result.nudge).toBeNull();
    expect(result.fallback).toBe('the operator could not be nudged for 10 minutes; 1 report(s) wait: deepseek-acme-2 asked a question: the operator\'s to act on');
    expect(memory.pending).toEqual([]);
  });

  test('carries no report that is the owner\'s to answer', () => {
    const stuck = live({ 'deepseek-acme': { status: 'idle', screen: permission } });
    expect(pass(team(), emptySession(), stuck, fine, 0, newMemory()).nudge).toBeNull();
  });
});

describe('team watch', () => {
  let dir: string;
  let file: string;
  let typed: string[];
  let notified: string[];
  let screenNow: string;
  let statusNow: string;
  let scene: Live | null;
  let clock: number;

  function sources(passes: number, over: Partial<WatchSources> = {}): WatchSources {
    let left = passes;
    return {
      live: () => scene,
      machine: () => fine,
      approval: () => [],
      screen: () => screenNow,
      status: () => statusNow,
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); return true; },
      pressEnter: (pane) => { typed.push(`${pane} <enter>`); return true; },
      notify: (text) => { notified.push(text); },
      now: () => new Date(clock),
      wait: async (seconds) => { clock += seconds * 1000; return --left > 0; },
      alive: () => false,
      pid: 4242,
      ...over,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-watch-'));
    mkdirSync(join(dir, '.agents'));
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, unparked);
    typed = [];
    notified = [];
    screenNow = idle;
    statusNow = 'idle';
    clock = Date.parse('2026-10-03T14:00:00Z');
    scene = live({ 'deepseek-acme-2': { status: 'blocked', screen: question } });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reports to the log, the desktop and the operator, and writes its heartbeat', async () => {
    const io = testIo(dir);
    let beat: unknown;
    const code = await runWatch(['--file', file], io, sources(2, {
      wait: async () => { beat ??= readState(join(dir, '.agents')).sessions['acme-web']?.watch; return false; },
    }));
    expect(code).toBe(0);
    expect(beat).toEqual({ pid: 4242, heartbeat: '2026-10-03T14:00:00.000Z' });
    expect(typed).toEqual([`w0:p1 ${NUDGE_TEXT}`, 'w0:p1 <enter>']);
    expect(typed[0]).not.toContain('asked a question');
    expect(notified[0]).toBe('deepseek-acme-2 asked a question: the operator\'s to act on');
    const log = readFileSync(join(dir, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('watch [watch] deepseek-acme-2 asked a question');
    expect(log).toContain('watch [watch] nudged the operator');
  });

  test('when it stops, its record is cleared and that is notified', async () => {
    await runWatch(['--file', file], testIo(dir), sources(1));
    expect(readState(join(dir, '.agents')).sessions['acme-web']?.watch).toBeUndefined();
    expect(notified[notified.length - 1]).toBe('the watch of "acme-web" stopped');
  });

  test('a prompt that appeared since the pass keeps the nudge pending: nothing is typed', async () => {
    screenNow = permission;
    await runWatch(['--file', file], testIo(dir), sources(1));
    expect(typed).toEqual([]);
    screenNow = idle;
  });

  test('a kept nudge is typed on a later pass, once the operator is free again', async () => {
    let calls = 0;
    await runWatch(['--file', file], testIo(dir), sources(2, { screen: () => (calls++ === 0 ? permission : idle) }));
    expect(typed).toEqual([`w0:p1 ${NUDGE_TEXT}`, 'w0:p1 <enter>']);
  });

  test('an operator that started working since the pass is not typed into', async () => {
    statusNow = 'working';
    await runWatch(['--file', file], testIo(dir), sources(1));
    expect(typed).toEqual([]);
  });

  test('a dialog that opens between the text and the Enter never gets the Enter', async () => {
    let looks = 0;
    const io = testIo(dir);
    await runWatch(['--file', file], io, sources(1, { screen: () => (looks++ === 0 ? idle : permission) }));
    expect(typed).toEqual([`w0:p1 ${NUDGE_TEXT}`]);
    expect(io.out).toContain('a nudge was typed and not sent');
  });

  test('the text in the box, seen before the Enter, is the nudge\'s own: the Enter is sent', async () => {
    let looks = 0;
    await runWatch(['--file', file], testIo(dir), sources(1, { screen: () => (looks++ === 0 ? idle : unsent) }));
    expect(typed[1]).toBe('w0:p1 <enter>');
  });

  test('--no-nudge types nothing and --no-notify notifies nothing; the log still has it', async () => {
    const io = testIo(dir);
    await runWatch(['--file', file, '--no-nudge', '--no-notify'], io, sources(1));
    expect(typed).toEqual([]);
    expect(notified).toEqual([]);
    expect(io.out).toContain(`nudge not typed (--no-nudge): ${NUDGE_TEXT}`);
    expect(readFileSync(join(dir, '.agents', 'team.log'), 'utf8')).toContain('deepseek-acme-2 asked a question');
  });
  test('a second watch on the same session refuses while the first is alive', async () => {
    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 99, heartbeat: '2026-10-03T13:59:00Z' } };
    });
    const io = testIo(dir);
    expect(await runWatch(['--file', file], io, sources(1, { alive: (pid) => pid === 99 }))).toBe(1);
    expect(io.err).toContain('a watch already runs for the session "acme-web" (pid 99)');
    // Another session is free, and so is this one once the first watch is dead.
    expect(await runWatch(['--file', file, '--session', 'team-test'], testIo(dir), sources(1, { alive: (pid) => pid === 99 }))).toBe(0);
    expect(await runWatch(['--file', file], testIo(dir), sources(1))).toBe(0);
  });

  test('a file broken while it runs: it says so once and keeps watching with the last valid copy', async () => {
    const io = testIo(dir);
    let round = 0;
    await runWatch(['--file', file], io, sources(3, {
      wait: async (seconds) => { clock += seconds * 1000; if (round++ === 0) writeFileSync(file, 'format: 9\n'); return round < 3; },
    }));
    expect(io.out.match(/team\.yaml is invalid/g)?.length).toBe(1);
    expect(io.out).toContain('using the copy of');
  });

  test('herdr that stops answering is reported once, and the watch keeps trying', async () => {
    scene = null;
    const io = testIo(dir);
    await runWatch(['--file', file], io, sources(3));
    expect(io.out.match(/herdr doesn't answer/g)?.length).toBe(1);
  });

  test('a file that never validated, and a bad option', async () => {
    writeFileSync(file, 'format: 9\n');
    expect(await runWatch(['--file', file], testIo(dir), sources(1))).toBe(2);
    expect(await runWatch(['--loud'], testIo(dir), sources(1))).toBe(2);
  });
});
