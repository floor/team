import { describe, expect, test } from 'bun:test';
import { budgetLine, budgetTable } from '../src/budgets/table.ts';
import type { Seen } from '../src/budgets/readings.ts';
import type { TeamFile } from '../src/file/types.ts';

const minute = 60 * 1000;
const now = 1_700_000_000_000;

function team(reserve: number | null): TeamFile {
  return {
    budgets: {
      staleAfter: 30 * 60,
      checkEvery: 600,
      marks: [50, 75, 90],
      accounts: {
        openai: { kind: 'subscription', shared: false, reserve, floor: null, sources: ['status_line'], check: null },
      },
    },
  } as unknown as TeamFile;
}

function reading(over: Partial<Seen> = {}): Seen {
  return {
    account: 'openai',
    window: 'weekly',
    left: 40,
    used: 60,
    changedAt: now - minute,
    resetsAt: now + 44 * minute,
    seat: 'one',
    confirmed: true,
    ...over,
  };
}

describe('the budgets table', () => {
  test('a fresh reading names what is left, when it resets, and how old it is', () => {
    const [row] = budgetTable(team(10), [reading()], now);
    expect(row?.state).toBe('fresh');
    expect(row?.inside).toBe(false);
    expect(budgetLine(row!, 10)).toBe('openai  weekly  left 40%  used 60%  resets in 44m  one  changed 1m ago  status line  fresh');
  });

  test('a fresh reading inside the reserve says so, and stays fresh', () => {
    const row = budgetTable(team(10), [reading({ left: 5, used: 95 })], now)[0];
    expect(row?.state).toBe('fresh');
    expect(row?.inside).toBe(true);
    expect(budgetLine(row!, 10)).toContain('fresh, inside reserve 10%');
  });

  test('a stale reading inside the reserve is refusing, and one with no reset is unknown', () => {
    const stale = reading({ changedAt: now - 30 * minute, left: 5, used: 95 });
    expect(budgetTable(team(10), [stale], now)[0]?.state).toBe('refusing');
    expect(budgetTable(team(10), [reading({ changedAt: now - 30 * minute, resetsAt: null })], now)[0]?.state).toBe('unknown');
  });

  test('a named account with no reading is its own unknown row', () => {
    expect(budgetLine(budgetTable(team(10), [], now)[0]!)).toBe('openai  unknown');
  });
});
