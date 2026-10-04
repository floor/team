// Which screen reading counts for an account and a window. A check reading
// has its own freshness and is not decided here.
import type { QuotaFigure, WindowName } from '../profiles/quota.ts';
import { emptySession, readState, updateState } from '../state.ts';

export type Seen = {
  account: string;
  window: WindowName;
  left: number;
  used: number;
  changedAt: number;
  resetsAt: number | null;
  seat: string;
  confirmed: boolean;
};

export type StoredReading = {
  account: string;
  window: WindowName;
  left: number;
  used: number;
  changedAt: string;
  resetsAt: string | null;
  seat: string;
  confirmed: boolean;
};

export type Verdict =
  | { kind: 'fresh' | 'unconfirmed' | 'stale' | 'refusing'; reading: Seen }
  | { kind: 'unknown' };

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
    confirmed: previous === null ? agreed : same ? previous.confirmed || agreed : true,
  };
  if (at < 0) next.push(reading);
  else next[at] = reading;
  return next;
}

/**
 * The reading that counts. A figure from before a known reset is dropped.
 * Among confirmed live readings, the newest change wins. A first sight counts
 * only when no confirmed reading is still live. Staleness is measured from
 * `changedAt`. A stale reading inside the reserve refuses until its reset;
 * with no reset time it is unknown.
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
  if (reading.resetsAt === null) return { kind: 'unknown' };
  return { kind: 'stale', reading };
}

/** Readings whose reset has passed are left out. One with no reset time is kept. */
export function remember(list: readonly Seen[], now: number): Record<string, StoredReading> {
  const out: Record<string, StoredReading> = {};
  for (const reading of list) {
    if (reading.resetsAt !== null && reading.resetsAt <= now) continue;
    out[`${reading.account}/${reading.window}/${reading.seat}`] = store(reading);
  }
  return out;
}

export function recall(stored: Record<string, StoredReading> | undefined): Seen[] {
  if (!stored) return [];
  return Object.values(stored).map(revive);
}

/** Write the readings that still count. The state file is the per-project cache. */
export function saveReadings(dir: string, session: string, list: readonly Seen[], now: number = Date.now()): void {
  updateState(dir, (state) => {
    const current = state.sessions[session] ?? emptySession();
    current.budgets = remember(list, now);
    state.sessions[session] = current;
  });
}

export function loadReadings(dir: string, session: string): Seen[] {
  return recall(readState(dir).sessions[session]?.budgets);
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
