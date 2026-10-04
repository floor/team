// The budgets table `status` prints. One row per account and window.
import type { TeamFile } from '../file/types.ts';
import type { WindowName } from '../profiles/quota.ts';
import { verdict, type Seen } from './readings.ts';

export type BudgetState = 'fresh' | 'unconfirmed' | 'stale' | 'refusing' | 'unknown';

export type BudgetRow = {
  account: string;
  window: WindowName | null;
  left: number | null;
  used: number | null;
  resetsIn: string | null;
  seat: string | null;
  age: string | null;
  source: 'status_line' | null;
  state: BudgetState;
  /** True when a subscription's left figure is at or inside its reserve. */
  inside: boolean;
};

const WINDOWS: WindowName[] = ['session', 'daily', 'weekly'];

/** Rows for the accounts the file names, and for any reading still in the state. */
export function budgetTable(team: TeamFile, list: readonly Seen[], now: number): BudgetRow[] {
  const staleAfterMs = team.budgets.staleAfter * 1000;
  const groups = new Map<string, Seen[]>();
  for (const reading of list) {
    const key = `${reading.account}\0${reading.window}`;
    const group = groups.get(key) ?? [];
    group.push(reading);
    groups.set(key, group);
  }
  const rows: BudgetRow[] = [];
  const named = new Set<string>();
  for (const [key, group] of groups) {
    const account = key.slice(0, key.indexOf('\0'));
    const window = group[0]?.window ?? null;
    named.add(account);
    const accountEntry = team.budgets.accounts[account];
    const reserve = accountEntry?.kind === 'subscription' ? accountEntry.reserve : null;
    rows.push(rowOf(account, window, verdict(group, now, staleAfterMs, reserve), now, reserve));
  }
  for (const account of Object.keys(team.budgets.accounts)) {
    if (!named.has(account)) rows.push(blank(account));
  }
  return rows.sort(byAccount);
}

export function budgetLine(row: BudgetRow, reserve: number | null = null): string {
  if (row.state === 'unknown' || row.left === null || row.used === null) {
    return [row.account, row.window, 'unknown'].filter((part) => part).join('  ');
  }
  const reset = row.resetsIn === null ? 'resets unknown' : `resets in ${row.resetsIn}`;
  const from = row.source === 'status_line' ? 'status line' : 'unknown source';
  const state = row.inside && reserve !== null ? `${row.state}, inside reserve ${reserve}%` : row.state;
  return `${row.account}  ${row.window}  left ${row.left}%  used ${row.used}%  ${reset}  ${row.seat}  changed ${row.age} ago  ${from}  ${state}`;
}

function rowOf(
  account: string,
  window: WindowName | null,
  result: ReturnType<typeof verdict>,
  now: number,
  reserve: number | null,
): BudgetRow {
  if (result.kind === 'unknown') return { ...blank(account), window };
  const reading = result.reading;
  return {
    account,
    window: reading.window,
    left: reading.left,
    used: reading.used,
    resetsIn: reading.resetsAt === null ? null : span(reading.resetsAt - now),
    seat: reading.seat,
    age: span(now - reading.changedAt),
    source: 'status_line',
    state: result.kind,
    inside: reserve !== null && reading.left <= reserve,
  };
}

function blank(account: string): BudgetRow {
  return {
    account,
    window: null,
    left: null,
    used: null,
    resetsIn: null,
    seat: null,
    age: null,
    source: null,
    state: 'unknown',
    inside: false,
  };
}

function byAccount(a: BudgetRow, b: BudgetRow): number {
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  const rank = (window: WindowName | null) => (window === null ? WINDOWS.length : WINDOWS.indexOf(window));
  return rank(a.window) - rank(b.window);
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h${rest}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}
