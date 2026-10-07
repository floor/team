import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { countedFor, loadReadings, loadSpendReadings, observe, observeCheck, paceFrom, recall, remember, revive, saveReadings, saveSpendReadings, store, updateReadings, verdict, type Seen, type StoredReading } from '../src/budgets/readings.ts';
import type { QuotaFigure } from '../src/profiles/quota.ts';
import { readState, STATE_FILE, updateState } from '../src/state.ts';

const minute = 60 * 1000;
const stale = 30 * minute;

function figure(left: number, resets: string | null = null): QuotaFigure {
  return { account: 'openai', window: 'weekly', left, used: 100 - left, resets };
}

function seen(over: Partial<Seen> & Pick<Seen, 'changedAt' | 'seat' | 'confirmed'>): Seen {
  return {
    account: 'openai',
    window: 'weekly',
    left: 40,
    used: 60,
    resetsAt: null,
    source: 'status_line',
    ...over,
  };
}

describe('which reading counts', () => {
  test('a first sight is unconfirmed, and staying there does not start the clock', () => {
    const first = observe([], figure(61), 'one', 0);
    const reading = first[0];
    expect(reading).toBeDefined();
    if (!reading) return;
    expect(verdict(first, 0, stale, 20)).toEqual({ kind: 'unconfirmed', reading });
    const later = observe(first, figure(61), 'one', stale + minute);
    expect(later[0]?.changedAt).toBe(0);
    expect(verdict(later, stale + minute, stale, 20).kind).toBe('unconfirmed');
  });

  test('a change on the same seat confirms it, and that newer change wins', () => {
    const older = observe([], figure(61), 'one', 0);
    const newer = observe(older, figure(40), 'one', minute);
    const counted = verdict(newer, minute, stale, 20);
    expect(counted.kind).toBe('fresh');
    if (counted.kind === 'unknown') return;
    expect(counted.reading.left).toBe(40);
    expect(counted.reading.confirmed).toBe(true);
    expect(counted.reading.changedAt).toBe(minute);
  });

  test('a confirmed reading still counts when a newer first sight arrives', () => {
    const older = observe([], figure(61), 'one', 0);
    const changed = observe(older, figure(40), 'one', minute);
    const sight = observe(changed, figure(20), 'two', minute * 2);
    const counted = verdict(sight, minute * 2, stale, 20);
    expect(counted.kind).toBe('fresh');
    if (counted.kind === 'unknown') return;
    expect(counted.reading.seat).toBe('one');
    expect(counted.reading.left).toBe(40);
  });

  test('a recalled confirmed reading still decides after a new seat differs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      const at = 1_700_000_000_000;
      const confirmed = observe(observe([], figure(61), 'one', at), figure(40), 'one', at + minute);
      saveReadings(dir, confirmed, at + minute);
      const sight = observe(loadReadings(dir), figure(20), 'two', at + minute * 2);
      const counted = verdict(sight, at + minute * 2, stale, 20);
      expect(counted.kind).toBe('fresh');
      if (counted.kind === 'unknown') return;
      expect(counted.reading.seat).toBe('one');
      expect(counted.reading.confirmed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an expired reading does not confirm a frozen pane', () => {
    const expired = seen({ seat: 'one', confirmed: true, changedAt: 0, left: 61, used: 39, resetsAt: 1 });
    const frozen = observe([expired], figure(61), 'two', minute);
    expect(frozen.find((item) => item.seat === 'two')?.confirmed).toBe(false);
  });

  test('an unchanged figure with no reset takes one when it appears', () => {
    const first = observe([], figure(61), 'one', 0);
    const later = observe(first, figure(61, '44m'), 'one', minute);
    expect(later[0]?.changedAt).toBe(0);
    expect(later[0]?.resetsAt).toBe(minute + 44 * minute);
  });

  test('a second seat showing the same figure confirms it', () => {
    const one = observe([], figure(61), 'one', 0);
    const two = observe(one, figure(61), 'two', minute);
    expect(verdict(two, minute, stale, 20).kind).toBe('fresh');
  });

  test('a confirmed reading wins a tie with an unconfirmed one', () => {
    const list = [
      seen({ seat: 'one', confirmed: false, changedAt: 5, left: 10, used: 90 }),
      seen({ seat: 'two', confirmed: true, changedAt: 5, left: 40, used: 60 }),
    ];
    const counted = verdict(list, 5, stale, null);
    expect(counted.kind).toBe('fresh');
    if (counted.kind === 'unknown') return;
    expect(counted.reading.seat).toBe('two');
  });

  test('a reading from before a known reset is dropped', () => {
    const list = [seen({ seat: 'one', confirmed: true, changedAt: 0, resetsAt: 10 })];
    expect(verdict(list, 10, stale, 20)).toEqual({ kind: 'unknown' });
  });

  test('a stale reading inside the reserve refuses until the reset', () => {
    const list = [seen({ seat: 'one', confirmed: true, changedAt: 0, left: 10, used: 90, resetsAt: stale * 4 })];
    expect(verdict(list, stale, stale, 20).kind).toBe('refusing');
  });

  test('a stale reading inside its reserve with no reset time is unknown', () => {
    const list = [seen({ seat: 'one', confirmed: true, changedAt: 0, left: 10, used: 90, resetsAt: null })];
    expect(verdict(list, stale, stale, 20)).toEqual({ kind: 'unknown' });
  });

  test('a stale reading with no reset, well outside its reserve, is last seen', () => {
    // Reserve 20: past twice it the figure is room the account may still hold, so it counts as
    // last seen rather than unknown — and it is never a refusal.
    const far = seen({ seat: 'one', confirmed: true, changedAt: 0, left: 70, used: 30, resetsAt: null });
    expect(verdict([far], stale, stale, 20)).toEqual({ kind: 'last-seen', reading: far });
    // At twice the reserve, the boundary included, it is still unknown.
    const near = seen({ seat: 'one', confirmed: true, changedAt: 0, left: 40, used: 60, resetsAt: null });
    expect(verdict([near], stale, stale, 20)).toEqual({ kind: 'unknown' });
    // Inside its reserve it never turns into a refusal: with no reset it is unknown, as before.
    const inside = seen({ seat: 'one', confirmed: true, changedAt: 0, left: 5, used: 95, resetsAt: null });
    expect(verdict([inside], stale, stale, 20)).toEqual({ kind: 'unknown' });
    // No reserve to measure against: unknown, as before.
    expect(verdict([far], stale, stale, null)).toEqual({ kind: 'unknown' });
  });

  test('a stale reading outside the reserve stays stale', () => {
    const list = [seen({ seat: 'one', confirmed: true, changedAt: 0, left: 80, used: 20, resetsAt: stale * 4 })];
    expect(verdict(list, stale, stale, 20).kind).toBe('stale');
  });

  test('the readings survive in the state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    const at = 1_700_000_000_000;
    const list = observe([], figure(39, '44m'), 'one', at);
    saveReadings(dir, list, at);
    const loaded = loadReadings(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.left).toBe(39);
    expect(loaded[0]?.resetsAt).toBe(1_700_000_000_000 + 44 * minute);
    expect(loaded[0]?.confirmed).toBe(false);
    const passed = seen({ seat: 'old', confirmed: true, changedAt: at, resetsAt: at });
    const kept = seen({ seat: 'open', confirmed: true, changedAt: at, resetsAt: null });
    saveReadings(dir, [passed, kept], at);
    expect(loadReadings(dir).map((item) => item.seat)).toEqual(['open']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('spend readings', () => {
  test('a save merges by account: one it did not read keeps its stored reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      const at = 1_700_000_000_000;
      saveSpendReadings(dir, [{ account: 'openai', amount: 12.4, currency: 'USD', at }]);
      expect(loadSpendReadings(dir)).toEqual([{ account: 'openai', amount: 12.4, currency: 'USD', at }]);
      saveSpendReadings(dir, [{ account: 'deepseek', amount: 4.2, currency: 'USD', at: at + minute }]);
      expect(loadSpendReadings(dir).map((one) => one.account).sort()).toEqual(['deepseek', 'openai']);
      // A later reading for the same account replaces the older one.
      saveSpendReadings(dir, [{ account: 'openai', amount: 3, currency: 'USD', at: at + minute }]);
      expect(loadSpendReadings(dir).find((one) => one.account === 'openai'))
        .toEqual({ account: 'openai', amount: 3, currency: 'USD', at: at + minute });
      // Nothing read, nothing written.
      saveSpendReadings(dir, []);
      expect(loadSpendReadings(dir).map((one) => one.account).sort()).toEqual(['deepseek', 'openai']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a check reading in the same slot', () => {
  const at = 1_700_000_000_000;

  test('is folded from a check window: confirmed at first sight, with no seat', () => {
    expect(observeCheck([], 'openai', [{ window: 'weekly', left: 5, used: 95, at, resetsAt: at + 3_600_000 }])).toEqual([
      { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: at, resetsAt: at + 3_600_000, seat: null, source: 'check', confirmed: true },
    ]);
  });

  test('replaces the last reading of its window and leaves the screen readings alone', () => {
    const screen = observe([], figure(40), 'one', at);
    const first = observeCheck(screen, 'openai', [{ window: 'weekly', left: 5, used: 95, at, resetsAt: null }]);
    const again = observeCheck(first, 'openai', [{ window: 'weekly', left: 8, used: 92, at: at + minute, resetsAt: null }]);
    expect(again.filter((item) => item.source === 'check')).toEqual([
      // The replaced figure is recorded as the point, at the check's own moment (§ 3-S3).
      { account: 'openai', window: 'weekly', left: 8, used: 92, changedAt: at + minute, resetsAt: null, seat: null, source: 'check', confirmed: true, was: { left: 5, at } },
    ]);
    expect(again.some((item) => item.source === 'status_line' && item.seat === 'one')).toBe(true);
  });

  test('survives the state file with its source, and one whose reset has passed does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      saveReadings(dir, observeCheck([], 'openai', [{ window: 'weekly', left: 5, used: 95, at, resetsAt: at + 3_600_000 }]), at + minute);
      expect(loadReadings(dir)).toEqual([
        { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: at, resetsAt: at + 3_600_000, seat: null, source: 'check', confirmed: true },
      ]);
      saveReadings(dir, observeCheck([], 'openai', [{ window: 'weekly', left: 5, used: 95, at, resetsAt: at + 2 * minute }]), at + 3 * minute);
      expect(loadReadings(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stored reading from before sources were recorded is a status-line reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
        format: 1,
        sessions: {
          default: {
            seats: {},
            worktrees: {},
            budgets: {
              'openai/weekly/one': {
                account: 'openai', window: 'weekly', left: 39, used: 61,
                changedAt: new Date(at).toISOString(), resetsAt: null, seat: 'one', confirmed: true,
              },
            },
          },
        },
      }, null, 2)}\n`);
      expect(loadReadings(dir).map((item) => item.source)).toEqual(['status_line']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fallback among the sources', () => {
  const at = 1_700_000_000_000;

  test('a stale check inside its reserve is the fallback, and a fresh lower source wins', () => {
    const check = seen({ seat: null, source: 'check', confirmed: true, changedAt: at - 31 * minute, left: 5, used: 95, resetsAt: at + 100 * 3_600_000 });
    // Nothing below it counts: rule 4's refusal holds for the check's figure too.
    expect(countedFor(['check', 'status_line'], [], [check], at, stale, 10))
      .toEqual({ kind: 'counted', reading: check });
    // § 3: a fresh status line below it is read, and its room clears the account.
    const screen = seen({ seat: 'one', confirmed: true, changedAt: at - minute, left: 50, used: 50 });
    expect(countedFor(['check', 'status_line'], [screen], [check], at, stale, 10))
      .toEqual({ kind: 'counted', reading: screen });
    // A stale check with room counts for nothing: with nothing below it, unknown.
    const roomy = seen({ ...check, left: 50, used: 50 });
    expect(countedFor(['check', 'status_line'], [], [roomy], at, stale, 10)).toEqual({ kind: 'unknown' });
  });

  test('a last-seen screen falls through to a fresh check below it', () => {
    // The failure direction: a stale higher source must not hide a fresh lower one.
    const screen = seen({ seat: 'one', confirmed: true, changedAt: at - 40 * minute, left: 70, used: 30, resetsAt: null });
    const check = seen({ seat: null, source: 'check', confirmed: true, changedAt: at - minute, left: 60, used: 40 });
    expect(countedFor(['status_line', 'check'], [screen], [check], at, stale, 20))
      .toEqual({ kind: 'counted', reading: check });
    // Nothing below it: the room the screen last showed is the answer.
    expect(countedFor(['status_line', 'check'], [screen], [], at, stale, 20))
      .toEqual({ kind: 'counted', reading: screen });
  });

  test('a last-seen reading below never clears a stale refusal above it', () => {
    // The check's stale figure inside the reserve is the refusal (rule 4); the screen's
    // last-seen room must not displace it — a depleted account must not launch on it.
    const check = seen({ seat: null, source: 'check', confirmed: true, changedAt: at - 31 * minute, left: 5, used: 95, resetsAt: at + 100 * 3_600_000 });
    const screen = seen({ seat: 'one', confirmed: true, changedAt: at - 40 * minute, left: 70, used: 30, resetsAt: null });
    expect(countedFor(['check', 'status_line'], [screen], [check], at, stale, 20))
      .toEqual({ kind: 'counted', reading: check });
  });

  test('a stale check with no reset and room is last seen, below a fresh lower source', () => {
    const check = seen({ seat: null, source: 'check', confirmed: true, changedAt: at - 31 * minute, left: 70, used: 30, resetsAt: null });
    expect(countedFor(['check', 'status_line'], [], [check], at, stale, 20))
      .toEqual({ kind: 'counted', reading: check });
    const fresh = seen({ seat: 'one', confirmed: true, changedAt: at - minute, left: 60, used: 40 });
    expect(countedFor(['check', 'status_line'], [fresh], [check], at, stale, 20))
      .toEqual({ kind: 'counted', reading: fresh });
  });

  test('an unconfirmed status line falls through to a fresh check below it', () => {
    const sight = seen({ seat: 'one', confirmed: false, changedAt: at, left: 20, used: 80 });
    const check = seen({ seat: null, source: 'check', confirmed: true, changedAt: at - minute, left: 80, used: 20 });
    // § 4.3 rule 5: a first sight is not the account's answer while a lower source has one.
    expect(countedFor(['status_line', 'check'], [sight], [check], at, stale, 10))
      .toEqual({ kind: 'counted', reading: check });
    // With nothing below it, the first sight is the answer it was.
    expect(countedFor(['status_line', 'check'], [sight], [], at, stale, 10))
      .toEqual({ kind: 'unconfirmed', reading: sight });
  });
});

describe('the project keeps the readings, not a session', () => {
  const at = 1_700_000_000_000;

  function screen(over: Partial<StoredReading> = {}): StoredReading {
    return {
      account: 'openai', window: 'weekly', left: 39, used: 61,
      changedAt: new Date(at).toISOString(), resetsAt: null, seat: 'one', source: 'status_line', confirmed: true,
      ...over,
    };
  }

  // A state file as the watch wrote it while readings were held per herdr session.
  function legacy(dir: string, sessions: Record<string, unknown>): void {
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({ format: 1, sessions }, null, 2)}\n`);
  }

  test('a reading held under a session is the project\'s: it is read with no session asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      legacy(dir, { 'acme-web': { seats: {}, worktrees: {}, budgets: { 'openai/weekly/one': screen() } } });
      expect(loadReadings(dir)).toEqual([
        { account: 'openai', window: 'weekly', left: 39, used: 61, changedAt: at, resetsAt: null, seat: 'one', source: 'status_line', confirmed: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a save writes the project\'s cache, and a later save folds into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      saveReadings(dir, observe([], figure(39), 'one', at), at);
      expect(loadReadings(dir).map(({ seat, left }) => [seat, left])).toEqual([['one', 39]]);
      saveReadings(dir, observe(loadReadings(dir), figure(20, '44m'), 'two', at + minute), at + minute);
      expect(loadReadings(dir).map(({ seat }) => seat).sort()).toEqual(['one', 'two']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the migration moves every session\'s records up, losing none, the newer change of a slot winning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      legacy(dir, {
        'acme-web': {
          seats: {}, worktrees: {},
          budgets: {
            'openai/weekly/one': screen(),
            'openai/session/one': screen({ window: 'session', left: 80, used: 20 }),
          },
        },
        other: {
          seats: {}, worktrees: {},
          budgets: { 'openai/weekly/one': screen({ left: 20, used: 80, changedAt: new Date(at + minute).toISOString() }) },
        },
      });
      const state = readState(dir);
      expect(recall(state.budgets).map(({ window, left }) => `${window}:${left}`).sort())
        .toEqual(['session:80', 'weekly:20']);
      expect(state.sessions['acme-web']).not.toHaveProperty('budgets');
      // Any later write persists the new shape: read old, write new.
      updateState(dir, () => {});
      const after = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
      expect(after.budgets['openai/weekly/one'].left).toBe(20);
      expect(after.sessions['acme-web'].budgets).toBeUndefined();
      expect(after.sessions['other'].budgets).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a confirmed reading is not displaced by a newer unconfirmed one of another session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      legacy(dir, {
        one: { seats: {}, worktrees: {}, budgets: { 'openai/weekly/one': screen({ left: 61, used: 39, confirmed: false }) } },
        two: { seats: {}, worktrees: {}, budgets: { 'openai/weekly/one': screen({ left: 39, used: 61, changedAt: new Date(at - minute).toISOString() }) } },
      });
      const kept = recall(readState(dir).budgets);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.confirmed).toBe(true);
      expect(kept[0]?.left).toBe(39);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('spend readings are the project\'s too, and a save merges into the migrated ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      legacy(dir, {
        'acme-web': {
          seats: {}, worktrees: {},
          spend: { openai: { account: 'openai', amount: 12.4, currency: 'USD', at: new Date(at).toISOString() } },
        },
      });
      expect(loadSpendReadings(dir)).toEqual([{ account: 'openai', amount: 12.4, currency: 'USD', at }]);
      saveSpendReadings(dir, [{ account: 'deepseek', amount: 4.2, currency: 'USD', at: at + minute }]);
      expect(loadSpendReadings(dir).map(({ account }) => account).sort()).toEqual(['deepseek', 'openai']);
      const after = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
      expect(after.spend.openai.amount).toBe(12.4);
      expect(after.sessions['acme-web'].spend).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the watch\'s fold', () => {
  test('runs where the state is held: a second fold is handed the first\'s reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      const at = 1_700_000_000_000;
      updateReadings(dir, at, (stored) => ({ readings: observe(stored, figure(39), 'one', at), value: null }));
      // A second watch of the same project, on another session, folds its own seat's figure. It
      // read nothing before the first wrote; its fold is handed the readings the state holds.
      let seen: number[] = [];
      updateReadings(dir, at, (stored) => {
        seen = stored.map((item) => item.left);
        return { readings: observe(stored, figure(20), 'two', at), value: null };
      });
      expect(seen).toEqual([39]);
      expect(loadReadings(dir).map(({ seat, left }) => [seat, left])).toEqual([['one', 39], ['two', 20]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('two watches folding at once lose nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-race-'));
    try {
      const at = 1_700_000_000_000;
      const module = new URL('../src/budgets/readings.ts', import.meta.url).pathname;
      const child = (seat: string, left: number) => `
        import { observe, updateReadings } from ${JSON.stringify(module)};
        updateReadings(${JSON.stringify(dir)}, ${at}, (stored) => {
          // Hold the lock while folding, so both watches overlap.
          Bun.sleepSync(200);
          return {
            readings: observe(stored, { account: 'openai', window: 'weekly', left: ${left}, used: ${100 - left}, resets: null }, ${JSON.stringify(seat)}, ${at}),
            value: null,
          };
        });
      `;
      const one = Bun.spawn(['bun', '-e', child('one', 39)], { stdout: 'ignore', stderr: 'ignore' });
      const two = Bun.spawn(['bun', '-e', child('two', 20)], { stdout: 'ignore', stderr: 'ignore' });
      expect(await Promise.all([one.exited, two.exited])).toEqual([0, 0]);
      expect(loadReadings(dir).map(({ seat, left }) => [seat, left]).sort()).toEqual([['one', 39], ['two', 20]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the stored point', () => {
  const T0 = 1_700_000_000_000;
  const T1 = T0 + minute;
  const T2 = T0 + 2 * minute;
  const T3 = T0 + 3 * minute;

  function stored(over: Partial<StoredReading> = {}): StoredReading {
    return {
      account: 'openai', window: 'weekly', left: 40, used: 60,
      changedAt: new Date(T0).toISOString(), resetsAt: null, seat: 'one', source: 'status_line', confirmed: true,
      ...over,
    };
  }

  /** A record holding whatever `was` a corrupted or hand-edited state might carry. */
  function held(was: unknown): StoredReading {
    return { ...stored(), was: was as StoredReading['was'] };
  }

  test('an old state without the value revives with no point', () => {
    const [reading] = recall({ 'openai/weekly/one': stored() });
    expect(reading).toBeDefined();
    expect(reading?.was).toBeUndefined();
    expect(reading?.left).toBe(40);
  });

  test('left unchanged keeps the standing point as it stands', () => {
    const reading = seen({ seat: 'one', confirmed: true, changedAt: T1, was: { left: 60, at: T0 } });
    const again = observe([reading], figure(40), 'one', T2);
    expect(again[0]?.changedAt).toBe(T1);
    expect(again[0]?.was).toEqual({ left: 60, at: T0 });
  });

  test('a changed figure records exactly the prior values', () => {
    const reading = seen({ seat: 'one', confirmed: true, changedAt: T1, was: { left: 60, at: T0 } });
    const moved = observe([reading], figure(30), 'one', T2);
    expect(moved[0]?.changedAt).toBe(T2);
    expect(moved[0]?.was).toEqual({ left: 40, at: T1 });
  });

  test('a later change replaces the point with the figure before it', () => {
    let list = observe([seen({ seat: 'one', confirmed: true, changedAt: T1, was: { left: 60, at: T0 } })], figure(30), 'one', T2);
    list = observe(list, figure(20), 'one', T3);
    expect(list[0]?.was).toEqual({ left: 30, at: T2 });
  });

  test('the rule holds in each slot: the check\'s own moment, and one never touches the other', () => {
    const screen = seen({ seat: 'one', confirmed: true, changedAt: T1, was: { left: 60, at: T0 } });
    const check = seen({ seat: null, source: 'check', confirmed: true, changedAt: T1, left: 5, used: 95, was: { left: 7, at: T0 } });
    const afterCheck = observeCheck([screen, check], 'openai', [{ window: 'weekly', left: 8, used: 92, at: T2, resetsAt: null }]);
    expect(afterCheck.find((item) => item.source === 'check')?.was).toEqual({ left: 5, at: T1 });
    expect(afterCheck.find((item) => item.source === 'status_line')?.was).toEqual({ left: 60, at: T0 });
    const afterScreen = observe(afterCheck, figure(30), 'one', T3);
    expect(afterScreen.find((item) => item.source === 'check')?.was).toEqual({ left: 5, at: T1 });
    expect(afterScreen.find((item) => item.source === 'status_line')?.was).toEqual({ left: 40, at: T1 });
  });

  test('a passed reset takes the record and its point together', () => {
    const live = seen({ seat: 'one', confirmed: true, changedAt: T1, resetsAt: T3, was: { left: 60, at: T0 } });
    const spent = seen({ seat: 'two', confirmed: true, changedAt: T1, resetsAt: T2, was: { left: 60, at: T0 } });
    const kept = remember([live, spent], T2);
    expect(Object.keys(kept)).toEqual(['openai/weekly/one']);
    expect(kept['openai/weekly/one']?.was).toEqual({ left: 60, at: new Date(T0).toISOString() });
  });

  test('a change into another window instance leaves no point, the next change inside it sets one', () => {
    const before = seen({ seat: 'one', confirmed: true, changedAt: T0, left: 60, used: 40, resetsAt: T0 + 10 * minute, was: { left: 70, at: T0 - minute } });
    const moved = observe([before], figure(40, '44m'), 'one', T1);
    expect(moved[0]?.resetsAt).toBe(T1 + 44 * minute);
    expect(moved[0]?.was).toBeUndefined();
    // The status line's countdown: a minute later the same reset reads 43m, the same instant.
    const again = observe(moved, figure(30, '43m'), 'one', T2);
    expect(again[0]?.resetsAt).toBe(T1 + 44 * minute);
    expect(again[0]?.was).toEqual({ left: 40, at: T1 });
  });

  test('an invalid point is discarded whole, every other field intact, never a throw', () => {
    const ok = new Date(T0).toISOString();
    const bad: unknown[] = [
      'nope',
      null,
      {},
      { left: 40, at: { when: ok } },
      { left: 140, at: ok },
      { left: -1, at: ok },
      { left: '40', at: ok },
      { left: 40, at: 'nope' },
      { left: 40, at: 1234 },
    ];
    for (const was of bad) {
      const revived = revive(held(was));
      expect(revived.was).toBeUndefined();
      expect(revived.left).toBe(40);
      expect(revived.used).toBe(60);
      expect(revived.changedAt).toBe(T0);
      expect(revived.resetsAt).toBeNull();
      expect(revived.seat).toBe('one');
      expect(revived.confirmed).toBe(true);
    }
    // The same through the state file, the one door a value from outside enters through.
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({ format: 1, sessions: {}, budgets: { 'openai/weekly/one': { ...stored(), was: 'nope' } } }, null, 2)}\n`);
      const [reading] = loadReadings(dir);
      expect(reading?.was).toBeUndefined();
      expect(reading?.left).toBe(40);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a well-formed but odd pair revives, and there is no pace to read from it', () => {
    // At after the change: it revives, and `dt` is not positive, so no pace.
    const odd = revive(held({ left: 50, at: new Date(T1).toISOString() }));
    expect(odd.was).toEqual({ left: 50, at: T1 });
    expect(paceFrom(odd, T2, stale)).toBeNull();
    // Left equal: shaped fine, a pace of zero — `-0` reads 0.
    const flat = revive(held({ left: 40, at: new Date(T0 - minute).toISOString() }));
    expect(paceFrom(flat, T1, stale)).toBe(0);
    const tiny = revive(held({ left: 39.99, at: new Date(T0 - 60 * minute).toISOString() }));
    expect(paceFrom(tiny, T1, stale)).toBe(0);
  });

  test('state read and write and the migration retain the field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      saveReadings(dir, [seen({ seat: 'one', confirmed: true, changedAt: T1, resetsAt: T3, was: { left: 60, at: T0 } })], T1);
      // An unrelated write rewrites the whole file; a record no fold touched keeps its point.
      updateState(dir, () => {});
      expect(readState(dir).budgets?.['openai/weekly/one']?.was).toEqual({ left: 60, at: new Date(T0).toISOString() });
      expect(loadReadings(dir)[0]?.was).toEqual({ left: 60, at: T0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const other = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      // A legacy session-held record with a point merges to the top level, whole: the confirmed
      // record wins the pick over a newer unconfirmed one, and its point rides it.
      writeFileSync(join(other, STATE_FILE), `${JSON.stringify({
        format: 1,
        sessions: {
          one: { seats: {}, worktrees: {}, budgets: { 'openai/weekly/one': stored({ was: { left: 60, at: new Date(T0).toISOString() } }) } },
          two: { seats: {}, worktrees: {}, budgets: { 'openai/weekly/one': stored({ confirmed: false, changedAt: new Date(T2).toISOString(), was: { left: 20, at: new Date(T1).toISOString() } }) } },
        },
      }, null, 2)}\n`);
      const merged = readState(other).budgets?.['openai/weekly/one'];
      expect(merged?.confirmed).toBe(true);
      expect(merged?.was).toEqual({ left: 60, at: new Date(T0).toISOString() });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    // store∘revive round-trips the point, both directions.
    const reading = seen({ seat: 'one', confirmed: true, changedAt: T1, was: { left: 60, at: T0 } });
    expect(revive(store(reading))).toEqual(reading);
    const record = stored({ was: { left: 60, at: new Date(T0).toISOString() } });
    expect(store(revive(record))).toEqual(record);
  });
});
