import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadReadings, observe, saveReadings, verdict, type Seen } from '../src/budgets/readings.ts';
import type { QuotaFigure } from '../src/profiles/quota.ts';

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

  test('a newer first sight wins, and stays unconfirmed', () => {
    const older = observe([], figure(61), 'one', 0);
    const changed = observe(older, figure(40), 'one', minute);
    const sight = observe(changed, figure(20), 'two', minute * 2);
    expect(verdict(sight, minute * 2, stale, 20).kind).toBe('unconfirmed');
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
    const list = observe([], figure(39, '44m'), 'one', 1_700_000_000_000);
    saveReadings(dir, 'default', list);
    const loaded = loadReadings(dir, 'default');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.left).toBe(39);
    expect(loaded[0]?.resetsAt).toBe(1_700_000_000_000 + 44 * minute);
    expect(loaded[0]?.confirmed).toBe(false);
  });
});
