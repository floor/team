// Whether `up` or `add` may start a seat, from the readings already stored.
// A subscription account is refused by a counted reading inside its reserve; a
// spend account by a counted money reading at or below its floor. A reading the
// gate can't count — missing, stale, or in another currency than the floor's —
// reads unknown: said, and never a refusal.
import type { Seat, TeamFile } from '../file/types.ts';
import type { WindowName } from '../profiles/quota.ts';
import { checkOf, countedFor, screenOf, type Seen, type SpendReading } from './readings.ts';

export type LaunchDecision =
  | { kind: 'clear' }
  | { kind: 'unknown'; account: string; text: string }
  | { kind: 'refuse'; why: string };

const RANK: Record<WindowName, number> = { session: 0, daily: 1, weekly: 2 };

/**
 * The seat's account is its own `account:` when the file names one — one vendor with two accounts
 * is two buckets (§ 3b) — and its vendor otherwise. `budgets` is the section in force: an
 * unapproved edit to a reserve refuses no one until it is approved, and an account only the
 * unapproved edit names is not an account at all. `spend` holds the stored spend check readings;
 * a subscription account never looks at them.
 */
export function seatBudget(
  budgets: TeamFile['budgets'],
  readings: readonly Seen[],
  seat: Seat,
  now: number,
  spend: readonly SpendReading[] = [],
): LaunchDecision {
  const name = seat.account ?? seat.vendor;
  const account = budgets.accounts[name];
  if (!account) return { kind: 'clear' };
  if (account.kind === 'spend') {
    const floor = account.floor;
    const reading = spend.find((item) => item.account === name);
    // § 5's freshness rule for a check reading, applied to the floor: a reading with no floor to
    // measure against, one read longer ago than `stale_after`, and one in another currency than
    // the floor's are the same answer — unknown, said, never a refusal.
    if (!floor || !reading || reading.currency !== floor.currency || now - reading.at >= budgets.staleAfter * 1000) {
      return { kind: 'unknown', account: name, text: `${name} is unknown` };
    }
    if (reading.amount > floor.amount) return { kind: 'clear' };
    const room = accountsWithRoom(budgets, readings, now, spend).filter((accountName) => accountName !== name);
    return {
      kind: 'refuse',
      why: `${name} spend ${money(reading.amount)} ${reading.currency}, at or below its ${money(floor.amount)} ${floor.currency} floor, read ${age(now - reading.at)} ago; accounts with room: ${room.length ? room.join(', ') : 'none'}`,
    };
  }

  const staleAfterMs = budgets.staleAfter * 1000;
  const mine = readings.filter((item) => item.account === name);
  let unknown = mine.length === 0;
  let unconfirmed = false;
  let counted = false;
  let worst: Seen | null = null;
  for (const group of windowsOf(mine)) {
    // The window's reading from the sources the account names, in order (§ 3, § 5): a check
    // reading counts by its own freshness, ahead of a screen reading below it.
    const result = countedFor(account.sources, screenOf(group), checkOf(group), now, staleAfterMs, account.reserve);
    if (result.kind === 'unknown') {
      unknown = true;
      continue;
    }
    // A first sight is unconfirmed. It never refuses.
    if (result.kind === 'unconfirmed') {
      unconfirmed = true;
      continue;
    }
    counted = true;
    if (account.reserve === null || result.reading.left > account.reserve) continue;
    if (
      !worst
      || result.reading.left < worst.left
      || (result.reading.left === worst.left && RANK[result.reading.window] < RANK[worst.window])
    ) {
      worst = result.reading;
    }
  }
  if (worst && account.reserve !== null) {
    const room = accountsWithRoom(budgets, readings, now).filter((accountName) => accountName !== name);
    // A check reading was measured, not changed on a screen: § 5's word for it.
    const when = worst.source === 'check' ? 'read' : 'changed';
    return {
      kind: 'refuse',
      why: `${name} ${worst.window} left ${worst.left}%, inside its ${account.reserve}% reserve, ${when} ${age(now - worst.changedAt)} ago; accounts with room: ${room.length ? room.join(', ') : 'none'}`,
    };
  }
  if (unknown) return { kind: 'unknown', account: name, text: `${name} is unknown` };
  if (unconfirmed && !counted) return { kind: 'unknown', account: name, text: `${name}: first sight only, not yet counted` };
  return { kind: 'clear' };
}

/**
 * Accounts whose counted figures leave room: a subscription with every counted window outside
 * its reserve, a spend account with a fresh reading above its floor.
 */
export function accountsWithRoom(
  budgets: TeamFile['budgets'],
  readings: readonly Seen[],
  now: number,
  spend: readonly SpendReading[] = [],
): string[] {
  const staleAfterMs = budgets.staleAfter * 1000;
  const names: string[] = [];
  for (const [name, account] of Object.entries(budgets.accounts)) {
    if (account.kind === 'spend') {
      const floor = account.floor;
      const reading = spend.find((item) => item.account === name);
      if (floor && reading && reading.currency === floor.currency && now - reading.at < staleAfterMs && reading.amount > floor.amount) {
        names.push(name);
      }
      continue;
    }
    if (account.reserve === null) continue;
    const groups = windowsOf(readings.filter((item) => item.account === name));
    let counted = 0;
    let inside = false;
    for (const group of groups) {
      const result = countedFor(account.sources, screenOf(group), checkOf(group), now, staleAfterMs, account.reserve);
      if (result.kind === 'unknown' || result.kind === 'unconfirmed') continue;
      counted += 1;
      if (result.reading.left <= account.reserve) inside = true;
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

/**
 * A money figure in a refusal, as read: up to four decimals — the most a check or a floor may
 * carry — with the trailing zeros beyond the cents dropped, and never fewer than two decimals.
 * The figure the words judge is the figure the eyes see. Exported so the machine view's spend
 * line writes the same figure the gate judged, and the two can never disagree.
 */
export function money(amount: number): string {
  const written = amount.toFixed(4).replace(/0+$/, '');
  return written.padEnd(written.indexOf('.') + 3, '0');
}
