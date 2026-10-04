// Which reading counts for an account and a window, from the sources the account names in order
// (§ 3): a check reading has its own freshness (§ 5) and is not decided by `verdict`, which
// decides the screen readings.
import type { QuotaFigure, WindowName } from '../profiles/quota.ts';
import type { CheckWindow } from './run.ts';
import { readState, updateState } from '../state.ts';

/** Where a reading came from: a pane's own status line, or an approved check command (§ 3). */
export type ReadingSource = 'status_line' | 'check';

export type Seen = {
  account: string;
  window: WindowName;
  left: number;
  used: number;
  changedAt: number;
  resetsAt: number | null;
  /** The seat whose screen showed it; null for a check reading, which belongs to no seat. */
  seat: string | null;
  source: ReadingSource;
  confirmed: boolean;
};

export type StoredReading = {
  account: string;
  window: WindowName;
  left: number;
  used: number;
  changedAt: string;
  resetsAt: string | null;
  seat: string | null;
  /** Absent in state files written before sources were recorded: a screen reading then. */
  source?: ReadingSource;
  confirmed: boolean;
};

export type Verdict =
  | { kind: 'fresh' | 'unconfirmed' | 'stale' | 'refusing' | 'last-seen'; reading: Seen }
  | { kind: 'unknown' };

/** A spend check reading (RFC 0003 § 5): the money the account still holds. */
export type SpendReading = {
  account: string;
  amount: number;
  currency: string;
  /** When the check ran: a spend line carries no time of its own (§ 5). */
  at: number;
};

export type StoredSpend = {
  account: string;
  amount: number;
  currency: string;
  at: string;
};

/** Fold one seat's figure into the readings kept for this pass. */
export function observe(list: readonly Seen[], figure: QuotaFigure, seat: string, now: number): Seen[] {
  const next = list.slice();
  const at = next.findIndex((item) => item.account === figure.account && item.window === figure.window && item.seat === seat);
  const previous = at < 0 ? null : next[at] ?? null;
  const same = previous !== null && previous.left === figure.left && previous.used === figure.used;
  const agreed = next.some((item) =>
    item !== previous
    && item.account === figure.account
    && item.window === figure.window
    && item.left === figure.left
    && item.used === figure.used
    && (item.resetsAt === null || item.resetsAt > now));
  const reading: Seen = {
    account: figure.account,
    window: figure.window,
    left: figure.left,
    used: figure.used,
    changedAt: same && previous ? previous.changedAt : now,
    resetsAt: same && previous && previous.resetsAt !== null ? previous.resetsAt : resetsFrom(figure.resets, now),
    seat,
    source: 'status_line',
    confirmed: previous === null ? agreed : same ? previous.confirmed || agreed : true,
  };
  if (at < 0) next.push(reading);
  else next[at] = reading;
  return next;
}

/**
 * Fold a check command's windows into the readings kept for this pass (§ 5). A check reading is
 * confirmed at first sight and belongs to no seat; one is kept per account and window, so a new
 * check replaces the last, and the screen readings of the same window are left alone.
 */
export function observeCheck(list: readonly Seen[], account: string, windows: readonly CheckWindow[]): Seen[] {
  const next = list.slice();
  for (const window of windows) {
    const reading: Seen = {
      account,
      window: window.window,
      left: window.left,
      used: window.used,
      changedAt: window.at,
      resetsAt: window.resetsAt,
      seat: null,
      source: 'check',
      confirmed: true,
    };
    const at = next.findIndex((item) => item.account === account && item.window === window.window && item.source === 'check');
    if (at < 0) next.push(reading);
    else next[at] = reading;
  }
  return next;
}

/** The screen readings in a list, and the check readings: the two slots of the same account. */
export function screenOf(list: readonly Seen[]): Seen[] {
  return list.filter((item) => item.source === 'status_line');
}

export function checkOf(list: readonly Seen[]): Seen[] {
  return list.filter((item) => item.source === 'check');
}

/**
 * The reading that counts. A figure from before a known reset is dropped.
 * Among confirmed live readings, the newest change wins. A first sight counts
 * only when no confirmed reading is still live. Staleness is measured from
 * `changedAt`. A stale reading inside the reserve refuses until its reset;
 * with no reset time it is unknown when it could still matter — inside the
 * reserve or within the reserve again outside it — and last seen when it sits
 * further out, room the account may still hold. It never refuses.
 */
export function verdict(list: readonly Seen[], now: number, staleAfterMs: number, reserve: number | null): Verdict {
  const live = list.filter((item) => item.resetsAt === null || item.resetsAt > now);
  const confirmed = live.filter((item) => item.confirmed);
  const ranked = confirmed.length > 0 ? confirmed : live;
  if (ranked.length === 0) return { kind: 'unknown' };
  const newest = Math.max(...ranked.map((item) => item.changedAt));
  const tied = ranked.filter((item) => item.changedAt === newest);
  const reading = tied.find((item) => item.confirmed) ?? tied[0];
  if (!reading) return { kind: 'unknown' };
  if (!reading.confirmed) return { kind: 'unconfirmed', reading };
  if (now - reading.changedAt < staleAfterMs) return { kind: 'fresh', reading };
  const inside = reserve !== null && reading.left <= reserve;
  if (inside && reading.resetsAt !== null) return { kind: 'refusing', reading };
  if (reading.resetsAt === null) {
    if (reserve !== null && reading.left > reserve * 2) return { kind: 'last-seen', reading };
    return { kind: 'unknown' };
  }
  return { kind: 'stale', reading };
}

export type CountedReading =
  | { kind: 'counted'; reading: Seen }
  | { kind: 'unconfirmed'; reading: Seen }
  | { kind: 'unknown' };

/**
 * The reading that counts for one window, from the sources the account names in order (§ 3, § 5):
 * a lower source is used only when every higher one is failed, unknown or stale. A check reading
 * counts while it is fresh by § 5's own time and its reset has not passed; a screen reading falls
 * through when it is unknown, and a bare first sight falls through too, so a fresh check below it
 * still counts (§ 4.3 rule 5). A stale reading inside its reserve with its reset ahead is kept as
 * the fallback, whichever source it came from, so rule 4 still refuses when nothing below counts.
 * A stale figure with no known reset counts as the room last seen only when it is well outside
 * the reserve, and it sits below any inside-reserve figure: a last sight never clears a refusal.
 */
export function countedFor(
  sources: readonly ReadingSource[],
  screen: readonly Seen[],
  checks: readonly Seen[],
  now: number,
  staleAfterMs: number,
  reserve: number | null,
): CountedReading {
  let fallback: Seen | null = null;
  let lastSeen: Seen | null = null;
  let unconfirmed: Seen | null = null;
  for (const source of sources) {
    if (source === 'check') {
      const reading = checks.find((item) => (item.resetsAt === null || item.resetsAt > now) && now - item.changedAt < staleAfterMs);
      if (reading) return { kind: 'counted', reading };
      // Rule 4 is about the reserve, not the source: a stale check figure inside it keeps
      // refusing until its known reset, and a fresh source below still wins over this fallback.
      const inside = checks.find((item) => item.resetsAt !== null && item.resetsAt > now && reserve !== null && item.left <= reserve);
      if (inside) fallback ??= inside;
      // A stale check figure with no reset, past the reserve again, is the room last seen.
      const sight = checks.find((item) => item.resetsAt === null && reserve !== null && item.left > reserve * 2);
      if (sight) lastSeen ??= sight;
      continue;
    }
    const result = verdict(screen, now, staleAfterMs, reserve);
    if (result.kind === 'unknown') continue;
    if (result.kind === 'unconfirmed') {
      unconfirmed ??= result.reading;
      continue;
    }
    if (result.kind === 'fresh') return { kind: 'counted', reading: result.reading };
    if (result.kind === 'last-seen') {
      lastSeen ??= result.reading;
      continue;
    }
    fallback ??= result.reading;
  }
  if (fallback) return { kind: 'counted', reading: fallback };
  if (lastSeen) return { kind: 'counted', reading: lastSeen };
  if (unconfirmed) return { kind: 'unconfirmed', reading: unconfirmed };
  return { kind: 'unknown' };
}

/** Readings whose reset has passed are left out. One with no reset time is kept. */
export function remember(list: readonly Seen[], now: number): Record<string, StoredReading> {
  const out: Record<string, StoredReading> = {};
  for (const reading of list) {
    if (reading.resetsAt !== null && reading.resetsAt <= now) continue;
    // A screen reading is kept per seat; a check reading belongs to no seat and is kept alone.
    const key = reading.source === 'check'
      ? `${reading.account}/${reading.window}`
      : `${reading.account}/${reading.window}/${reading.seat}`;
    out[key] = store(reading);
  }
  return out;
}

export function recall(stored: Record<string, StoredReading> | undefined): Seen[] {
  if (!stored) return [];
  return Object.values(stored).map(revive);
}

/** Write the readings that still count. The state file is the per-project cache (§ 4.4). */
export function saveReadings(dir: string, list: readonly Seen[], now: number = Date.now()): void {
  updateState(dir, (state) => {
    state.budgets = remember(list, now);
  });
}

/**
 * One pass's fold, read and written under the state lock (§ 4.4): `fold` is handed the readings
 * the state holds and returns the list to keep, so a watch folding while another watch writes
 * folds onto what was written, never over a list it read before it. Whatever the fold returns as
 * its `value` is handed back.
 */
export function updateReadings<T>(dir: string, now: number, fold: (stored: Seen[]) => { readings: Seen[]; value: T }): T {
  return updateState(dir, (state) => {
    const folded = fold(recall(state.budgets));
    state.budgets = remember(folded.readings, now);
    return folded.value;
  });
}

export function loadReadings(dir: string): Seen[] {
  return recall(readState(dir).budgets);
}

/**
 * Write the spend readings a pass's checks read, merging by account: an account whose check did
 * not run this pass keeps the reading the state already holds. Nothing read, nothing written.
 */
export function saveSpendReadings(dir: string, list: readonly SpendReading[]): void {
  if (!list.length) return;
  updateState(dir, (state) => {
    const spend = state.spend ?? {};
    for (const reading of list) spend[reading.account] = storeSpend(reading);
    state.spend = spend;
  });
}

export function loadSpendReadings(dir: string): SpendReading[] {
  return recallSpend(readState(dir).spend);
}

export function storeSpend(reading: SpendReading): StoredSpend {
  return {
    account: reading.account,
    amount: reading.amount,
    currency: reading.currency,
    at: new Date(reading.at).toISOString(),
  };
}

export function recallSpend(stored: Record<string, StoredSpend> | undefined): SpendReading[] {
  if (!stored) return [];
  return Object.values(stored).map((one) => ({
    account: one.account,
    amount: one.amount,
    currency: one.currency,
    at: Date.parse(one.at),
  }));
}

export function store(reading: Seen): StoredReading {
  return {
    account: reading.account,
    window: reading.window,
    left: reading.left,
    used: reading.used,
    changedAt: new Date(reading.changedAt).toISOString(),
    resetsAt: reading.resetsAt === null ? null : new Date(reading.resetsAt).toISOString(),
    seat: reading.seat,
    source: reading.source,
    confirmed: reading.confirmed,
  };
}

export function revive(stored: StoredReading): Seen {
  return {
    account: stored.account,
    window: stored.window,
    left: stored.left,
    used: stored.used,
    changedAt: Date.parse(stored.changedAt),
    resetsAt: stored.resetsAt === null ? null : Date.parse(stored.resetsAt),
    seat: stored.seat,
    source: stored.source ?? 'status_line',
    confirmed: stored.confirmed,
  };
}

/** When a duration such as `114h4m` ends, counted from a time. Null for no or an odd duration. */
export function resetsFrom(duration: string | null, now: number): number | null {
  if (duration === null) return null;
  const match = /^(?:([0-9]+)h)?(?:([0-9]+)m)?$/.exec(duration);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  return now + (hours * 60 + minutes) * 60 * 1000;
}
