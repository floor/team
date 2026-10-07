import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLine } from '../src/log.ts';
import { LOG_FILE } from '../src/state.ts';

describe('the log is evidence, never a decision', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'team-log-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const agents = () => join(dir, '.agents');

  test('a line lands whole when it can be written', () => {
    logLine(agents(), 'up', 'owner', 'refused: something', new Date('2026-10-07T12:00:00.000Z'));
    expect(readFileSync(join(agents(), LOG_FILE), 'utf8')).toBe('2026-10-07T12:00:00.000Z up [owner] refused: something\n');
  });

  test('a log path that is a directory is dropped, never thrown', () => {
    // A write that can only fail is the owner's business, not the command's: nothing here throws.
    mkdirSync(join(agents(), LOG_FILE), { recursive: true });
    expect(() => logLine(agents(), 'up', 'owner', 'refused: something')).not.toThrow();
    expect(statSync(join(agents(), LOG_FILE)).isDirectory()).toBe(true);
  });

  test('a `.agents` that is a file is dropped, never thrown', () => {
    writeFileSync(agents(), 'not a directory\n');
    expect(() => logLine(agents(), 'watch', 'watch', 'readings: unread')).not.toThrow();
  });
});
