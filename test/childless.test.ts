import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { childlessAnswer, childlessOf } from '../src/herdr.ts';

describe('pgrep\'s answer, as the exited proof reads it', () => {
  test('exit 1 with no output is the only no-child answer', () => {
    expect(childlessAnswer(1, '')).toBe(true);
    expect(childlessAnswer(1, '\n')).toBe(true);
  });

  test('one pid per line at exit 0 says a child is there', () => {
    expect(childlessAnswer(0, '91433\n')).toBe(false);
    expect(childlessAnswer(0, '91433\n14768\n')).toBe(false);
  });

  test('anything else is null, never a guess', () => {
    // A child printed without exit 0, or no child printed at exit 0: contradictions.
    expect(childlessAnswer(1, '91433\n')).toBeNull();
    expect(childlessAnswer(0, '')).toBeNull();
    // Output that is not bare pids.
    expect(childlessAnswer(0, 'zsh\n')).toBeNull();
    expect(childlessAnswer(0, '91433 14768\n')).toBeNull();
    // Another exit status, or none at all — the tool missing, a timeout, a kill.
    expect(childlessAnswer(2, '')).toBeNull();
    expect(childlessAnswer(null, '')).toBeNull();
  });
});

// The live reading: a real pgrep against real processes, on this machine or the check job's
// Linux runner alike, so the exit-status and output shapes are proven where they run.
describe('a process with and without a child, read by pid only', () => {
  test('a leaf process reads true and a parent reads false', async () => {
    const leaf = spawn('sleep', ['30'], { stdio: 'ignore' });
    leaf.unref();
    await new Promise<void>((resolve) => leaf.once('spawn', () => resolve()));
    expect(childlessOf(leaf.pid!)).toBe(true);

    // Two commands, so the shell cannot exec the first away: while it waits, it is a parent.
    const parent = spawn('bash', ['-c', 'sleep 30; sleep 30'], { stdio: 'ignore' });
    parent.unref();
    await new Promise<void>((resolve) => parent.once('spawn', () => resolve()));
    let read: boolean | null = null;
    for (let tries = 0; tries < 50 && read !== false; tries++) {
      read = childlessOf(parent.pid!);
      if (read !== false) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(read).toBe(false);
    parent.kill();
    leaf.kill();
  });
});
