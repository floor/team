import { spawn } from 'node:child_process';
import { expect, test } from 'bun:test';
import { commands, main } from '../src/cli.ts';
import type { Io } from '../src/io.ts';

function io(): Io & { out: string } {
  const state = {
    out: '',
    stdout(text: string) { state.out += text; },
    stderr() {},
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: false,
  };
  return state;
}

function ask(input: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['src/cli.ts', 'conformance-adapter'], {
      cwd: new URL('..', import.meta.url).pathname,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { out += text; });
    child.stderr.on('data', (text) => { err += text; });
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    child.stdin.end(input);
  });
}

test('conformance-adapter is hidden from help', async () => {
  expect(Object.keys(commands)).not.toContain('conformance-adapter');
  const help = io();
  expect(await main(['--help'], help)).toBe(0);
  expect(help.out).not.toContain('conformance-adapter');
});

test('the adapter answers one JSON line per request', async () => {
  const input = [
    JSON.stringify({ op: 'classify', cli: 'no-such', lines: ['hello'] }),
    JSON.stringify({ op: 'composer', cli: 'no-such', lines: [] }),
    JSON.stringify({ op: 'yaml', text: 'a: 1\n' }),
    JSON.stringify({ op: 'yaml', text: '# nothing\n' }),
  ].join('\n') + '\n';
  const result = await ask(input);
  expect(result.code).toBe(0);
  expect(result.out).toBe([
    '{"kind":"unknown"}',
    '{"kind":"unknown"}',
    '{"ok":true}',
    '{"ok":false}',
    '',
  ].join('\n'));
});
