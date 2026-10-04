// The budget check (RFC 0003 § 6, § 7): the marks a window has crossed, an account inside its
// reserve or floor, and an account that reads unknown while seats run on it. The core hands it
// the seats' quota figures and what the check commands read; it reads no screen, runs nothing,
// and never refuses a seat — the launch gate owns refusing. Turn-off-able in `watch.checks`.
import type { BudgetAccount } from '../../file/types.ts';
import { verdict, type Seen } from '../../budgets/readings.ts';
import { WINDOWS, type WindowName } from '../../profiles/quota.ts';
import { reported, type CheckContext, type Report, type TeamCheck, type TeamObservation } from '../check.ts';

// A window with a figure that counts this pass, from whichever source the account's `sources`
// name: the first source that has one wins, and the ones below it are not read (§ 4.3).
type Position = { window: WindowName; left: number; used: number; resetsAt: number | null };
type Counted = { kind: 'subscription'; windows: Position[] } | { kind: 'spend'; amount: number; currency: string };

// The marks already reported in the window a figure belongs to (§ 6).
type MarkState = { used: number; resetsAt: number | null; reported: number[] };

export const budget: TeamCheck = {
  name: 'budget',
  run(team, ctx) {
    const reports: Report[] = [];
    const marks = ctx.memory<Record<string, MarkState>>('budget', () => ({}));
    const staleMs = ctx.budgets.staleAfter * 1000;
    for (const [name, account] of Object.entries(ctx.budgets.accounts)) {
      const counted = countedOf(name, account, team, staleMs, ctx.now);
      // A figure nobody has yet seen (a first sight, not yet counted) is not "unknown": the
      // launch gate is the one that says so, and a watch restart would otherwise report every run.
      if (counted === 'unseen') continue;
      if (counted === null) {
        reports.push(...reported(unknown(name, team, ctx)));
        continue;
      }
      if (counted.kind === 'spend') {
        const floor = account.floor;
        if (floor !== null && counted.amount <= floor.amount) {
          const text = `${name} ${counted.amount} ${counted.currency} left, at its ${floor.amount} ${floor.currency} floor`;
          reports.push(...reported(ctx.once(`budget:floor:${name}`, text, 'owner')));
        }
        continue;
      }
      reports.push(...crossings(marks, name, counted.windows, ctx.budgets.marks, ctx.now));
      const reserve = account.reserve;
      if (reserve === null) continue;
      const inside = counted.windows.filter((window) => window.left <= reserve);
      const worst = inside.reduce<Position | null>((a, b) => (a === null ? b : tightest(a, b)), null);
      if (worst) {
        const text = `${name} ${worst.window} left ${worst.left}%, inside its ${reserve}% reserve`;
        reports.push(...reported(ctx.once(`budget:reserve:${name}`, text, 'owner')));
      }
    }
    return reports;
  },
};

/**
 * The account's figure this pass, from the first source that has one (§ 4.3, § 5). A check
 * reading counts while it is fresh; a screen reading counts when the verdict keeps it — fresh,
 * stale, or refusing — and a bare first sight is `unseen`. Null: nothing counts at all.
 */
function countedOf(
  name: string,
  account: BudgetAccount,
  team: TeamObservation,
  staleMs: number,
  now: number,
): Counted | 'unseen' | null {
  for (const source of account.sources) {
    if (source === 'check') {
      const outcome = team.outcomes.find((one) => one.account === name);
      if (!outcome || outcome.state !== 'read') continue;
      if (outcome.reading.kind === 'spend') {
        if (now - outcome.reading.at < staleMs) {
          return { kind: 'spend', amount: outcome.reading.amount, currency: outcome.reading.currency };
        }
        continue;
      }
      const windows = outcome.reading.windows
        .filter((window) => now - window.at < staleMs)
        .map(({ window, left, used, resetsAt }) => ({ window, left, used, resetsAt }));
      if (windows.length) return { kind: 'subscription', windows };
      continue;
    }
    const groups = new Map<WindowName, Seen[]>();
    for (const reading of team.readings) {
      if (reading.account !== name) continue;
      // The check readings of the same account live in this slot too: this source reads screens.
      if (reading.source !== 'status_line') continue;
      const group = groups.get(reading.window) ?? [];
      group.push(reading);
      groups.set(reading.window, group);
    }
    const windows: Position[] = [];
    let seen = false;
    for (const group of groups.values()) {
      const result = verdict(group, now, staleMs, account.reserve);
      if (result.kind === 'unknown') continue;
      if (result.kind === 'unconfirmed') {
        seen = true;
        continue;
      }
      windows.push({
        window: result.reading.window,
        left: result.reading.left,
        used: result.reading.used,
        resetsAt: result.reading.resetsAt,
      });
    }
    if (windows.length) return { kind: 'subscription', windows };
    if (seen) return 'unseen';
    continue;
  }
  return null;
}

/** The account reads unknown while a seat that spends it is running: the operator can stop it. */
function unknown(name: string, team: TeamObservation, ctx: CheckContext): Report | null {
  const on = team.seats.filter((seat) => seat.running && seat.account === name).map((seat) => seat.name);
  if (!on.length) return null;
  const verb = on.length === 1 ? 'runs' : 'run';
  return ctx.once(`budget:unknown:${name}`, `${name} is unknown while ${on.join(', ')} ${verb} on it`, 'operator');
}

/**
 * The marks this pass's figures cross (§ 6): each once per window, re-armed at the window's
 * known reset, or — with no reset time known — when the figure drops ten points, which is a
 * new window's figure.
 */
function crossings(
  marks: Record<string, MarkState>,
  name: string,
  windows: readonly Position[],
  list: readonly number[],
  now: number,
): Report[] {
  const reports: Report[] = [];
  for (const window of windows) {
    const key = `${name}\0${window.window}`;
    const previous = marks[key];
    const already = previous && !rearmed(previous, window, now) ? previous.reported : [];
    const crossed = list.filter((mark) => window.used >= mark && !already.includes(mark));
    for (const mark of crossed) {
      reports.push({
        key: `budget:mark:${name}:${window.window}:${mark}`,
        text: `${name} ${window.window} is ${window.used}% used, past the ${mark}% mark`,
        to: 'operator',
      });
    }
    marks[key] = { used: window.used, resetsAt: window.resetsAt, reported: [...already, ...crossed] };
  }
  return reports;
}

function rearmed(previous: MarkState, window: Position, now: number): boolean {
  if (previous.resetsAt !== null && now >= previous.resetsAt) {
    // The window the marks were reported in has ended; the new figure names the next one.
    return window.resetsAt === null || window.resetsAt > now;
  }
  return previous.resetsAt === null && window.used <= previous.used - 10;
}

function tightest(a: Position, b: Position): Position {
  if (a.left !== b.left) return b.left < a.left ? b : a;
  return WINDOWS.indexOf(b.window) < WINDOWS.indexOf(a.window) ? b : a;
}
