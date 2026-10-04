import { afterEach, describe, expect, test } from 'bun:test';
import { paneRead, setPaneExec } from '../src/herdr.ts';

// paneRead's process call is injectable, so these tests ask what it requests, what it falls
// back to and when it gives up — without a live herdr. The timeout error it must recognise
// is the one execFileSync throws: an Error with `killed` set.
describe('paneRead', () => {
  afterEach(() => setPaneExec(null));

  test('the styled read is the first call, its CRLF folded', () => {
    const calls: string[][] = [];
    setPaneExec((args) => {
      calls.push(args);
      return 'a\r\nb\r\n';
    });
    expect(paneRead('%1', 8)).toBe('a\nb\n');
    expect(calls.length).toBe(1);
    expect(calls[0]?.at(-2)).toBe('--format');
    expect(calls[0]?.at(-1)).toBe('ansi');
  });

  test('an herdr without --format falls back to the exact call main makes', () => {
    const calls: string[][] = [];
    setPaneExec((args) => {
      calls.push(args);
      if (args.includes('--format')) throw new Error('unknown option --format');
      return 'plain\n';
    });
    expect(paneRead('%1', 8)).toBe('plain\n');
    expect(calls.length).toBe(2);
    expect(calls[1]?.includes('--format')).toBe(false);
    expect(calls[1]?.at(-1)).toBe('8');
  });

  test('both calls refused reads nothing', () => {
    setPaneExec(() => {
      throw new Error('refused');
    });
    expect(paneRead('%1', 8)).toBeNull();
  });

  test('a hung herdr is not asked twice', () => {
    const calls: string[][] = [];
    setPaneExec((args) => {
      calls.push(args);
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), { killed: true });
    });
    expect(paneRead('%1', 8)).toBeNull();
    expect(calls.length).toBe(1);
  });
});
