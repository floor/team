// Whether `up` or `add` may start a seat, from the readings already stored.
// A spend account has no money figure in the state yet, so it is unknown:
// said, and not refused, until a check reading exists.
import type { Seat, TeamFile } from '../file/types.ts';
import type { WindowName } from '../profiles/quota.ts';
import { verdict, type Seen } from './readings.ts';

export type LaunchDecision =
  | { kind: 'clear' }
  | { kind: 'unknown'; account: string }
  | { kind: 'refuse'; why: string };

const RANK: Record<WindowName, number> = { session: 0, daily: 1, weekly: 2 };

/** The seat's account is its vendor. There is no separate account field on a seat. */
export function seatBudget(team: TeamFile, readings: readonly Seen[], seat: Seat, now: number): LaunchDecision {
  const name = seat.vendor;
  const account = team.budgets.accounts[name];
  if (!account) return { kind: 'clear' };
  if (account.kind === 'spend') return { kind: 'unknown', account: name };

  const staleAfterMs = team.budgets.staleAfter * 1000;
  const mine = readings.filter((item) => item.account === name);
  let unknown = mine.length === 0;
  let worst: Seen | null = null;
  for (const group of windowsOf(mine)) {
    const result = verdict(group, now, staleAfterMs, account.reserve);
    if (result.kind === 'unknown') {
      unknown = true;
      continue;
    }
    // A first sight is unconfirmed. It never refuses, and it is not unknown.
    if (result.kind === 'unconfirmed') continue;
    const inside = account.reserve !== null && result.reading.left <= account.reserve;
    if (!inside && result.kind !== 'refusing') continue;
    if (
      !worst
      || result.reading.left < worst.left
      || (result.reading.left === worst.left && RANK[result.reading.window] < RANK[worst.window])
    ) {
      worst = result.reading;
    }
  }
  if (worst) {
    const room = accountsWithRoom(team, readings, now).filter((accountName) => accountName !== name);
    return {
      kind: 'refuse',
      why: `${name} ${worst.window} left ${worst.left}%, changed ${age(now - worst.changedAt)} ago; room: ${room.length ? room.join(', ') : 'none'}`,
    };
  }
  if (unknown) return { kind: 'unknown', account: name };
  return { kind: 'clear' };
}

/** Subscription accounts whose counted windows are all outside the reserve. */
export function accountsWithRoom(team: TeamFile, readings: readonly Seen[], now: number): string[] {
  const staleAfterMs = team.budgets.staleAfter * 1000;
  const names: string[] = [];
  for (const [name, account] of Object.entries(team.budgets.accounts)) {
    if (account.kind !== 'subscription' || account.reserve === null) continue;
    const groups = windowsOf(readings.filter((item) => item.account === name));
    let counted = 0;
    let inside = false;
    for (const group of groups) {
      const result = verdict(group, now, staleAfterMs, account.reserve);
      if (result.kind === 'unknown' || result.kind === 'unconfirmed') continue;
      counted += 1;
      if (result.kind === 'refusing' || result.reading.left <= account.reserve) inside = true;
    }
    if (counted > 0 && !inside) names.push(name);
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function windowsOf(list: readonly Seen[]): Seen[][] {
  const groups = new Map<WindowName, Seen[]>();
  for (const reading of list) {
    const group = groups.get(reading.window) ?? [];
    group.push(reading);
    groups.set(reading.window, group);
  }
  return [...groups.values()];
}

function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h${rest}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}
