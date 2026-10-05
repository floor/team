import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSeatLock, seatLockPath } from '../../src/launch/seat-lock.ts';

describe('the seat lock', () => {
  test('a dead holder is taken over, and a live one is left alone', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-lock-')));
    mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
    const path = seatLockPath(dir, 'acme', 'lead');
    writeFileSync(path, '2147483646\n');
    const taken = acquireSeatLock(dir, 'acme', 'lead');
    expect('release' in taken).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`);
    if ('release' in taken) taken.release();

    writeFileSync(path, `${process.pid}\n`);
    const held = acquireSeatLock(dir, 'acme', 'lead');
    expect(held).toEqual({ held: process.pid });
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n`);
  });
});
