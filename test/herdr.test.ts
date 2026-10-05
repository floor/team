import { afterEach, describe, expect, test } from 'bun:test';
import { paneRead, setHerdrRun, setPaneExec, workspacePanes } from '../src/herdr.ts';

// paneRead's process call is injectable, so these tests ask what it requests, what it falls
// back to and when it gives up — without a live herdr. The timeout error it must recognise
// is the one execFileSync really throws: an Error with code ETIMEDOUT, signal SIGTERM and
// status null — and no killed field.
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
      throw Object.assign(new Error('spawnSync herdr ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
    });
    expect(paneRead('%1', 8)).toBeNull();
    expect(calls.length).toBe(1);
  });
});

describe('workspacePanes', () => {
  afterEach(() => setHerdrRun(null));

  test('valid entries for the requested workspace return string pane ids', () => {
    setHerdrRun(() => ({
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1' },
        { pane_id: 'w1:p2', workspace_id: 'w1' },
      ],
    }));
    expect(workspacePanes('w1')).toEqual(['w1:p1', 'w1:p2']);
  });

  test('the right pane id under another workspace id reads null', () => {
    setHerdrRun(() => ({
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w2' }],
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('entry under no workspace id reads null', () => {
    setHerdrRun(() => ({
      panes: [{ pane_id: 'w1:p1' }],
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('a non-object entry reads null', () => {
    setHerdrRun(() => ({
      panes: ['w1:p1'],
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('a pane id that is not a string reads null', () => {
    setHerdrRun(() => ({
      panes: [{ pane_id: 123, workspace_id: 'w1' }],
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('the right entry plus one malformed entry reads null', () => {
    setHerdrRun(() => ({
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1' },
        { pane_id: 'w1:p2' },
      ],
    }));
    expect(workspacePanes('w1')).toBeNull();
  });
});
