import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadReadings, loadSpendReadings, observe, observeCheck, saveReadings, saveSpendReadings, verdict, type Seen } from '../src/budgets/readings.ts';
import type { QuotaFigure } from '../src/profiles/quota.ts';
import { updateState } from '../src/state.ts';

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
      saveReadings(dir, 'default', confirmed, at + minute);
      const sight = observe(loadReadings(dir, 'default'), figure(20), 'two', at + minute * 2);
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

  test('a stale reading with no reset time is unknown', () => {
    const list = [seen({ seat: 'one', confirmed: true, changedAt: 0, left: 10, used: 90, resetsAt: null })];
    expect(verdict(list, stale, stale, 20)).toEqual({ kind: 'unknown' });
  });

  test('a stale reading outside the reserve stays stale', () => {
    const list = [seen({ seat: 'one', confirmed: true, changedAt: 0, left: 80, used: 20, resetsAt: stale * 4 })];
    expect(verdict(list, stale, stale, 20).kind).toBe('stale');
  });

  test('the readings survive in the state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    const at = 1_700_000_000_000;
    const list = observe([], figure(39, '44m'), 'one', at);
    saveReadings(dir, 'default', list, at);
    const loaded = loadReadings(dir, 'default');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.left).toBe(39);
    expect(loaded[0]?.resetsAt).toBe(1_700_000_000_000 + 44 * minute);
    expect(loaded[0]?.confirmed).toBe(false);
    const passed = seen({ seat: 'old', confirmed: true, changedAt: at, resetsAt: at });
    const kept = seen({ seat: 'open', confirmed: true, changedAt: at, resetsAt: null });
    saveReadings(dir, 'default', [passed, kept], at);
    expect(loadReadings(dir, 'default').map((item) => item.seat)).toEqual(['open']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('spend readings', () => {
  test('a save merges by account: one it did not read keeps its stored reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      const at = 1_700_000_000_000;
      saveSpendReadings(dir, 'default', [{ account: 'openai', amount: 12.4, currency: 'USD', at }]);
      expect(loadSpendReadings(dir, 'default')).toEqual([{ account: 'openai', amount: 12.4, currency: 'USD', at }]);
      saveSpendReadings(dir, 'default', [{ account: 'deepseek', amount: 4.2, currency: 'USD', at: at + minute }]);
      expect(loadSpendReadings(dir, 'default').map((one) => one.account).sort()).toEqual(['deepseek', 'openai']);
      // A later reading for the same account replaces the older one.
      saveSpendReadings(dir, 'default', [{ account: 'openai', amount: 3, currency: 'USD', at: at + minute }]);
      expect(loadSpendReadings(dir, 'default').find((one) => one.account === 'openai'))
        .toEqual({ account: 'openai', amount: 3, currency: 'USD', at: at + minute });
      // Nothing read, nothing written.
      saveSpendReadings(dir, 'other', []);
      expect(loadSpendReadings(dir, 'other')).toEqual([]);
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
      { account: 'openai', window: 'weekly', left: 8, used: 92, changedAt: at + minute, resetsAt: null, seat: null, source: 'check', confirmed: true },
    ]);
    expect(again.some((item) => item.source === 'status_line' && item.seat === 'one')).toBe(true);
  });

  test('survives the state file with its source, and one whose reset has passed does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      saveReadings(dir, 'default', observeCheck([], 'openai', [{ window: 'weekly', left: 5, used: 95, at, resetsAt: at + 3_600_000 }]), at + minute);
      expect(loadReadings(dir, 'default')).toEqual([
        { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: at, resetsAt: at + 3_600_000, seat: null, source: 'check', confirmed: true },
      ]);
      saveReadings(dir, 'default', observeCheck([], 'openai', [{ window: 'weekly', left: 5, used: 95, at, resetsAt: at + 2 * minute }]), at + 3 * minute);
      expect(loadReadings(dir, 'default')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stored reading from before sources were recorded is a status-line reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-readings-'));
    try {
      updateState(dir, (state) => {
        state.sessions['default'] = {
          seats: {},
          worktrees: {},
          budgets: {
            'openai/weekly/one': {
              account: 'openai', window: 'weekly', left: 39, used: 61,
              changedAt: new Date(at).toISOString(), resetsAt: null, seat: 'one', confirmed: true,
            },
          },
        };
      });
      expect(loadReadings(dir, 'default').map((item) => item.source)).toEqual(['status_line']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
