// RFC 0003 § 3b: a seat names its account through its vendor, or through an explicit `account:`
// when one vendor has two. The seat's account is what the gate, the readings, the reports and the
// status table key on; a seat that names none spends its vendor.
import { describe, expect, test } from 'bun:test';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { seatBudget } from '../src/budgets/gate.ts';
import type { Seen } from '../src/budgets/readings.ts';
import { budgetTable } from '../src/budgets/table.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass } from '../src/watch/pass.ts';

const NOW = Date.parse('2026-10-04T09:00:00Z');

// Two seats of one vendor on two accounts, and a coordinator that names none: its account is its
// vendor.
const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: codex-work
    cli: codex
    vendor: openai
    account: openai-work
    model: GPT Sol
    version: "6"
    launch: codex
  - role: implementer
    name: codex-home
    cli: codex
    vendor: openai
    account: openai-home
    model: GPT Sol
    version: "6"
    launch: codex
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }
    openai-home: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

// The same file with a vendor-named account the two seats must not share.
const WITH_VENDOR = TEAM.replace(
  '    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }',
  '    openai: { kind: subscription, reserve: 50%, sources: [status_line] }\n    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }',
);

function team(text: string = TEAM): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function seatOf(name: string, text: string = TEAM) {
  const seat = team(text).seats.find((one) => one.name === name);
  if (!seat) throw new Error(`no seat ${name}`);
  return seat;
}

function reading(account: string, left: number): Seen {
  return {
    account,
    window: 'weekly',
    left,
    used: 100 - left,
    changedAt: NOW - 60_000,
    resetsAt: NOW + 3_600_000,
    seat: account,
    source: 'status_line',
    confirmed: true,
  };
}

// A live team of exactly the seats given, each in a workspace of its own with its own screen.
function live(screens: Record<string, string>): Live {
  const agents: HerdrAgent[] = [];
  const panes: Record<string, string> = {};
  let n = 0;
  for (const [name, screen] of Object.entries(screens)) {
    const workspace = `w${n++}`;
    agents.push({ name, agent: name.startsWith('codex') ? 'codex' : 'claude', pane: `${workspace}:p1`, workspace, status: 'working', cwd: null });
    panes[`${workspace}:p1`] = screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: panes };
}

const CODEX = (left: number) => `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly ${left}% left\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };

describe('an account on a seat (§ 3b)', () => {
  test('the file reads each seat\'s own account, and leaves it unwritten where there is none', () => {
    expect(seatOf('codex-work').account).toBe('openai-work');
    expect(seatOf('codex-home').account).toBe('openai-home');
    // Absent, not the vendor: the default is applied where the account is read, never in the file.
    expect(Object.hasOwn(seatOf('lead'), 'account')).toBe(false);
  });

  test('an account is the owner\'s: it is part of the seat\'s fingerprint', () => {
    const without = TEAM.replace('    account: openai-work\n', '').replace('    account: openai-home\n', '');
    const before = fingerprints(team(without));
    const after = fingerprints(team());
    expect(before.seats['codex-work']).not.toBe(after.seats['codex-work']);
    expect(before.seats['lead']).toBe(after.seats['lead']);
    expect(after.seats['codex-work']).not.toBe(after.seats['codex-home']);
  });

  test('the gate measures each seat against its own account, not the vendor they share', () => {
    const budgets = team().budgets;
    const work = seatOf('codex-work');
    const home = seatOf('codex-home');
    expect(seatBudget(budgets, [reading('openai-work', 5), reading('openai-home', 80)], work, NOW)).toEqual({
      kind: 'refuse',
      why: 'openai-work weekly left 5%, inside its 10% reserve, changed 1m ago; accounts with room: openai-home',
    });
    // The other seat of the vendor keeps its own account: room here, and unknown with no reading.
    expect(seatBudget(budgets, [reading('openai-work', 5), reading('openai-home', 80)], home, NOW)).toEqual({ kind: 'clear' });
    expect(seatBudget(budgets, [reading('openai-work', 5)], home, NOW))
      .toEqual({ kind: 'unknown', account: 'openai-home', text: 'openai-home is unknown' });
  });

  test('a reading under the vendor\'s name is not a reading for the seat on an account', () => {
    const budgets = team(WITH_VENDOR).budgets;
    const work = seatOf('codex-work', WITH_VENDOR);
    expect(seatBudget(budgets, [reading('openai', 1)], work, NOW))
      .toEqual({ kind: 'unknown', account: 'openai-work', text: 'openai-work is unknown' });
    expect(seatBudget(budgets, [reading('openai', 1), reading('openai-work', 80)], work, NOW)).toEqual({ kind: 'clear' });
  });

  test('the default: a seat that names no account reads its vendor\'s', () => {
    const budgets = team().budgets;
    const lead = seatOf('lead');
    expect(seatBudget(budgets, [reading('anthropic', 5)], lead, NOW)).toEqual({
      kind: 'refuse',
      why: 'anthropic weekly left 5%, inside its 20% reserve, changed 1m ago; accounts with room: none',
    });
    expect(seatBudget(budgets, [reading('openai-work', 80)], lead, NOW))
      .toEqual({ kind: 'unknown', account: 'anthropic', text: 'anthropic is unknown' });
  });
});

describe('the watch reads a seat\'s figures onto its own account', () => {
  test('a screen figure is kept under the seat\'s account, and the status table shows both rows', () => {
    const result = pass({
      team: team(),
      state: emptySession(),
      live: live({ 'codex-work': CODEX(39), 'codex-home': CODEX(20) }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
    });
    expect(result.readings.map(({ account, seat, left }) => ({ account, seat, left }))).toEqual([
      { account: 'openai-work', seat: 'codex-work', left: 39 },
      { account: 'openai-home', seat: 'codex-home', left: 20 },
    ]);
    expect(budgetTable(team().budgets, result.readings, NOW).map((row) => [row.account, row.window, row.seat, row.left])).toEqual([
      ['anthropic', null, null, null],
      ['openai-home', 'weekly', 'codex-home', 20],
      ['openai-work', 'weekly', 'codex-work', 39],
    ]);
  });

  test('the unknown report names the seats on the account, not the vendor\'s others', () => {
    const result = pass({
      team: team(),
      state: emptySession(),
      live: live({ 'codex-work': CODEX(39), 'codex-home': 'Welcome to Codex\n' }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
    });
    expect(result.reports.filter((report) => report.key.startsWith('budget:')).map((report) => report.text))
      .toEqual(['openai-home is unknown while codex-home runs on it']);
  });

  test('a temporary seat is read as the seat it is like: its account too', () => {
    const state: SessionState = emptySession();
    state.seats['codex-temp'] = { stage: 'ready', temporary: { like: 'codex-work', until: 'result:briefs/x.result.md' } };
    const result = pass({
      team: team(),
      state,
      live: live({ 'codex-work': CODEX(39), 'codex-temp': CODEX(12) }),
      machine: fine,
      now: NOW,
      memory: newMemory(),
      approval: [],
    });
    expect(result.readings.map(({ account, seat, left }) => ({ account, seat, left }))).toEqual([
      { account: 'openai-work', seat: 'codex-work', left: 39 },
      { account: 'openai-work', seat: 'codex-temp', left: 12 },
    ]);
  });
});
