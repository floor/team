// RFC 0003 § 4.1, § 6, § 7 and § 9.5 through the watch: the core parses each seat's quota line
// into the observation, records it for the accounts whose `sources` take it, and the budget
// check reports the marks a window crosses, an account inside its reserve or floor, and one that
// reads unknown while seats run on it. Fixtures only: no screen here is a real session's.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WATCH_CHECKS_CHANGED } from '../src/approve/fingerprint.ts';
import type { CheckOutcome } from '../src/budgets/run.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass as corePass, type Memory, type PassResult } from '../src/watch/pass.ts';

/**
 * A pass over this file's budget world. `pass` takes the watch values in force and the loop's
 * check readings as its 8th and 9th parameters; these tests vary only the budget inputs, so the
 * file's own watch values are passed explicitly (no approval is in play here).
 */
function pass(
  team: TeamFile,
  state: SessionState,
  live: Live,
  machine: Machine,
  now: number,
  memory: Memory,
  approval: string[] | null = [],
  outcomes: readonly CheckOutcome[] = [],
): PassResult {
  return corePass(team, state, live, machine, now, memory, approval, team.watch, outcomes);
}

const NOW = Date.parse('2026-10-04T09:00:00Z');
const MIN = 60_000;
const WEEK = 7 * 24 * 3600_000;
const RESET = NOW + WEEK;

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

// Where a real file writes its accounts and its checks: under the section, at its indentation.
const MARKS = '  marks: [50, 75, 90]          # percent used, per account and window';
const UNSENT = '  unsent_after: 1m';

function source(accounts = '', checks = ''): string {
  return example
    .replace(MARKS, accounts ? `${MARKS}\n${accounts}` : MARKS)
    .replace(UNSENT, checks ? `${UNSENT}\n${checks}` : UNSENT);
}

function team(accounts = '', checks = ''): TeamFile {
  const result = validateTeamFile(source(accounts, checks));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const OPENAI = '  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [check], check: openai-quota }\n';
const RESERVE = '  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [check], check: openai-quota }\n';
const SCREEN_READ = '  accounts:\n    openai: { kind: subscription, reserve: 3%, sources: [status_line] }\n';
const DEEPSEEK = '  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n';

// Screens of Claude Code, as the live team shows them, and a Codex one whose last line is the
// quota line the codex profile reads.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const quota = `• Working (2m 10s • esc to interrupt)\n\n⚠ You have less than 25% of your weekly\n\nweekly 39% left\n`;

type Over = Partial<Record<string, { status?: string; screen?: string }>>;

function agent(name: string, workspace: string, status: string, kind: string): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team: the coordinator idle at its prompt, the rest working. A seat named in
// `drop` is not running at all.
function live(over: Over = {}, drop: string[] = []): Live {
  const seats: [string, string, string, string, string][] = [
    ['claude-coordinator-acme', 'w0', 'idle', 'claude', idle],
    ['codex-acme', 'w1', 'working', 'codex', ''],
    ['deepseek-acme', 'w2', 'working', 'claude', busy],
    ['deepseek-acme-2', 'w3', 'working', 'claude', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, kind, screen] of seats) {
    if (drop.includes(name)) continue;
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, kind));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };

const budgetReports = (result: PassResult) => result.reports.filter((report) => report.key.startsWith('budget:'));
const shown = (result: PassResult) => budgetReports(result).map((report) => `${report.text} (${report.to})`);

function checkWindows(
  account: string,
  now: number,
  windows: { window: 'session' | 'daily' | 'weekly'; left: number; used: number; resetsAt?: number | null }[],
): CheckOutcome[] {
  return [{
    account,
    state: 'read',
    reading: { kind: 'subscription', windows: windows.map((window) => ({ ...window, at: now, resetsAt: window.resetsAt ?? null })) },
  }];
}

function checkSpend(account: string, now: number, amount: number): CheckOutcome[] {
  return [{ account, state: 'read', reading: { kind: 'spend', amount, currency: 'USD', at: now } }];
}

describe('the seats\' quota, parsed by the core', () => {
  test('a screen figure becomes a reading for an account whose sources take one', () => {
    const result = pass(team(SCREEN_READ), emptySession(), live({ 'codex-acme': { screen: quota } }), fine, NOW, newMemory(), []);
    expect(result.readings.map(({ account, window, left, used, seat, confirmed }) => ({ account, window, left, used, seat, confirmed })))
      .toEqual([{ account: 'openai', window: 'weekly', left: 39, used: 61, seat: 'codex-acme', confirmed: false }]);
    // A first sight is not yet counted: the launch gate is what says "first sight only" (§ 4.3).
    expect(budgetReports(result)).toEqual([]);
  });

  test('an account whose sources name only the check takes no screen reading (floor-86)', () => {
    const result = pass(team(OPENAI), emptySession(), live({ 'codex-acme': { screen: quota } }), fine, NOW, newMemory(), []);
    expect(result.readings).toEqual([]);
    // Nothing counts for it this pass, and a seat spends it: unknown while running.
    expect(shown(result)).toEqual(['openai is unknown while codex-acme runs on it (operator)']);
  });
});

describe('the marks', () => {
  const week = (now: number, used: number, resetsAt: number | null) =>
    checkWindows('openai', now, [{ window: 'weekly', left: 100 - used, used, resetsAt }]);

  function marks(memory: ReturnType<typeof newMemory>, now: number, outcomes: CheckOutcome[]): string[] {
    const result = pass(team(OPENAI), emptySession(), live(), fine, now, memory, [], outcomes);
    return budgetReports(result).filter((report) => report.key.startsWith('budget:mark:')).map((report) => report.text);
  }

  test('each mark is reported once per window, and armed again at its reset', () => {
    const memory = newMemory();
    expect(marks(memory, NOW, week(NOW, 92, RESET))).toEqual([
      'openai weekly is 92% used, past the 50% mark',
      'openai weekly is 92% used, past the 75% mark',
      'openai weekly is 92% used, past the 90% mark',
    ]);
    expect(marks(memory, NOW + MIN, week(NOW + MIN, 93, RESET))).toEqual([]);
    // A dip below a mark before the reset does not arm it again.
    expect(marks(memory, NOW + 2 * MIN, week(NOW + 2 * MIN, 60, RESET))).toEqual([]);
    expect(marks(memory, NOW + 3 * MIN, week(NOW + 3 * MIN, 94, RESET))).toEqual([]);
    // The reset passes: the next window's figure crosses them again.
    expect(marks(memory, RESET + MIN, week(RESET + MIN, 55, RESET + WEEK))).toEqual([
      'openai weekly is 55% used, past the 50% mark',
    ]);
  });

  test('with no reset time, a figure ten points lower is a new window\'s', () => {
    const memory = newMemory();
    expect(marks(memory, NOW, week(NOW, 60, null))).toEqual(['openai weekly is 60% used, past the 50% mark']);
    expect(marks(memory, NOW + MIN, week(NOW + MIN, 58, null))).toEqual([]);
    expect(marks(memory, NOW + 2 * MIN, week(NOW + 2 * MIN, 45, null))).toEqual([]);
    expect(marks(memory, NOW + 3 * MIN, week(NOW + 3 * MIN, 55, null))).toEqual(['openai weekly is 55% used, past the 50% mark']);
  });

  test('a mark is the operator\'s to act on', () => {
    const result = pass(team(OPENAI), emptySession(), live(), fine, NOW, newMemory(), [], week(NOW, 92, RESET));
    expect(budgetReports(result).every((report) => report.to === 'operator')).toBe(true);
  });
});

describe('the reserve and the floor', () => {
  test('an account inside its reserve is the owner\'s, once, and again when it comes back', () => {
    const memory = newMemory();
    const at = (now: number, outcomes: CheckOutcome[]) =>
      budgetReports(pass(team(RESERVE), emptySession(), live(), fine, now, memory, [], outcomes))
        .filter((report) => report.key.startsWith('budget:reserve:'))
        .map((report) => `${report.text} (${report.to})`);
    expect(at(NOW, checkWindows('openai', NOW, [{ window: 'weekly', left: 7, used: 93, resetsAt: RESET }])))
      .toEqual(['openai weekly left 7%, inside its 10% reserve (owner)']);
    expect(at(NOW + MIN, checkWindows('openai', NOW + MIN, [{ window: 'weekly', left: 6, used: 94, resetsAt: RESET }])))
      .toEqual([]);
    expect(at(NOW + 2 * MIN, checkWindows('openai', NOW + 2 * MIN, [{ window: 'weekly', left: 60, used: 40, resetsAt: RESET }])))
      .toEqual([]);
    // The tightest window inside the reserve is the one named.
    expect(at(NOW + 3 * MIN, checkWindows('openai', NOW + 3 * MIN, [
      { window: 'session', left: 9, used: 91, resetsAt: null },
      { window: 'weekly', left: 6, used: 94, resetsAt: null },
    ]))).toEqual(['openai weekly left 6%, inside its 10% reserve (owner)']);
  });

  test('a spend account at or below its floor is the owner\'s, once, and again when it comes back', () => {
    const memory = newMemory();
    const at = (now: number, amount: number) =>
      budgetReports(pass(team(DEEPSEEK), emptySession(), live(), fine, now, memory, [], checkSpend('deepseek', now, amount)))
        .filter((report) => report.key.startsWith('budget:floor:'))
        .map((report) => `${report.text} (${report.to})`);
    expect(at(NOW, 4.2)).toEqual(['deepseek 4.2 USD left, at its 5 USD floor (owner)']);
    expect(at(NOW + MIN, 3)).toEqual([]);
    expect(at(NOW + 2 * MIN, 7.5)).toEqual([]);
    expect(at(NOW + 3 * MIN, 5)).toEqual(['deepseek 5 USD left, at its 5 USD floor (owner)']);
  });

  test('a spend account crosses no marks', () => {
    const result = pass(team(DEEPSEEK), emptySession(), live(), fine, NOW, newMemory(), [], checkSpend('deepseek', NOW, 4.2));
    expect(budgetReports(result).filter((report) => report.key.startsWith('budget:mark:'))).toEqual([]);
  });
});

describe('an account that reads unknown', () => {
  const unreadable: CheckOutcome[] = [{ account: 'openai', state: 'unreadable' }];

  test('is reported to the operator while seats run on it', () => {
    const memory = newMemory();
    const at = (now: number, outcomes: CheckOutcome[], scene = live()) =>
      budgetReports(pass(team(RESERVE), emptySession(), scene, fine, now, memory, [], outcomes))
        .filter((report) => report.key === 'budget:unknown:openai')
        .map((report) => `${report.text} (${report.to})`);
    expect(at(NOW, unreadable)).toEqual(['openai is unknown while codex-acme runs on it (operator)']);
    expect(at(NOW + MIN, unreadable)).toEqual([]);
    // A reading clears it; unknown again is new news.
    expect(at(NOW + 2 * MIN, checkWindows('openai', NOW + 2 * MIN, [{ window: 'weekly', left: 61, used: 39, resetsAt: RESET }])))
      .toEqual([]);
    expect(at(NOW + 3 * MIN, unreadable)).toEqual(['openai is unknown while codex-acme runs on it (operator)']);
  });

  test('is quiet when no running seat spends it', () => {
    const result = pass(team(RESERVE), emptySession(), live({}, ['codex-acme']), fine, NOW, newMemory(), [], unreadable);
    expect(budgetReports(result)).toEqual([]);
  });

  test('is not what a first sight is called', () => {
    const result = pass(team(SCREEN_READ), emptySession(), live({ 'codex-acme': { screen: quota } }), fine, NOW, newMemory(), [], []);
    expect(budgetReports(result)).toEqual([]);
  });
});

describe('watch.checks', () => {
  test('turns the budget check off, once the owner approved the change', () => {
    const crossed = checkWindows('openai', NOW, [{ window: 'weekly', left: 8, used: 92, resetsAt: RESET }]);
    const off = team(OPENAI, '  checks:\n    budget: off\n');
    expect(budgetReports(pass(off, emptySession(), live(), fine, NOW, newMemory(), [], crossed))).toEqual([]);
    // The same file with the change not approved yet: the off is not in effect, and marks run.
    const waiting = pass(off, emptySession(), live(), fine, NOW, newMemory(), [WATCH_CHECKS_CHANGED], crossed);
    expect(budgetReports(waiting).filter((report) => report.key.startsWith('budget:mark:'))).toHaveLength(3);
  });
});
