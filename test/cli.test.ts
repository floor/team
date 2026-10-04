import { expect, test } from 'bun:test';
import { commands, main, version } from '../src/cli.ts';
import type { Io } from '../src/io.ts';

function io(): Io & { out: string; err: string } {
  const state = {
    out: '',
    err: '',
    stdout(text: string) { state.out += text; },
    stderr(text: string) { state.err += text; },
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: false,
  };
  return state;
}

test('--version prints the package version', async () => {
  const run = io();
  expect(await main(['--version'], run)).toBe(0);
  expect(run.out.trim()).toBe(version());
  expect(version()).toMatch(/^\d+\.\d+\.\d+/);
});

test('--help prints the usage and exits 0; no command exits 2', async () => {
  const help = io();
  expect(await main(['--help'], help)).toBe(0);
  expect(help.out).toContain('Usage: team <command>');
  expect(await main([], io())).toBe(2);
});

test('an unknown command is an error', async () => {
  const run = io();
  expect(await main(['frobnicate'], run)).toBe(2);
  expect(run.err).toContain('unknown command "frobnicate"');
});

test('check is a command of this build', async () => {
  const run = io();
  expect(await main(['check', '--help'], run)).toBe(0);
  expect(run.out).toStartWith('usage: team check <ref>');
  const help = io();
  await main(['--help'], help);
  expect(help.out).toContain('\n  check\n');
});

test('every command of the table takes --help and -h, and prints its usage', async () => {
  const table = Object.entries(commands);
  expect(table.length).toBeGreaterThan(0);
  for (const [name, load] of table) {
    const usage = (await load()).USAGE;
    for (const flag of ['--help', '-h']) {
      const run = io();
      expect(await main([name, flag], run)).toBe(0);
      expect(run.out).toBe(usage);
      const first = run.out.split('\n')[0] ?? '';
      expect(first).toMatch(new RegExp(`^[Uu]sage: team ${name}\\b`));
    }
  }
});
