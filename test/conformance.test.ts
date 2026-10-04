import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { commands, main } from '../src/cli.ts';
import type { Io } from '../src/io.ts';
import { run } from '../scripts/conformance.ts';

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

test('the runner accepts the TypeScript adapter and rejects a command that does not answer', async () => {
  const passed = await run('bun src/cli.ts conformance-adapter');
  expect(passed.code).toBe(0);
  expect(passed.report).toMatch(/conformance: \d+ pass, 0 fail$/);
  expect(passed.report).toContain('pass  non-ASCII');
  expect(passed.report).toContain('pass  yaml');
  const failed = await run('true');
  expect(failed.code).toBe(1);
  expect(failed.report).toContain('fail  impl');
});

const dirs: string[] = [];

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A path a stand-in implementation touches, so a test can see whether it was started. */
function marker(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-ran-'));
  dirs.push(dir);
  return join(dir, 'ran');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the manifest gate', () => {
  test('a fixture the manifest does not list fails before the implementation runs', async () => {
    const dir = scratch({
      'conformance.json': '{"screens":[],"yaml":[]}',
      'claude-code/2.1.289/extra.txt': 'a screen beside the captures\n',
      'yaml/an-unlisted-case.yaml': 'a: 1\n',
    });
    const ran = marker();
    const result = await run(`touch ${ran}`, dir);
    expect(result.code).toBe(1);
    expect(result.report).toContain('claude-code/2.1.289/extra.txt');
    expect(result.report).toContain('yaml/an-unlisted-case.yaml');
    expect(result.report).toMatch(/conformance: 0 pass, 2 fail$/);
    expect(existsSync(ran)).toBe(false);
  });

  test('a new folder is not silently exempt', async () => {
    const dir = scratch({
      'conformance.json': '{"screens":[],"yaml":[]}',
      'wibble/deep/thing.txt': 'not a screen either way\n',
    });
    const ran = marker();
    const result = await run(`touch ${ran}`, dir);
    expect(result.code).toBe(1);
    expect(result.report).toContain('wibble/deep/thing.txt');
    expect(existsSync(ran)).toBe(false);
  });

  test('a README, a JSON shape and a named-exempt folder are not fixtures', async () => {
    const dir = scratch({
      'conformance.json': '{"screens":[],"yaml":[]}',
      'README.md': '# fixtures\n',
      'claude-code/README.md': '# the screens\n',
      'claude-code/2.1.289/shape.json': '{}\n',
      'herdr/claude-plain.json': '{}\n',
      'herdr/notes.txt': 'not a screen\n',
      'linux/proc/loadavg': '0.10 0.20 0.30\n',
    });
    const ran = marker();
    const result = await run(`touch ${ran}`, dir);
    expect(result.code).toBe(0);
    expect(result.report).toBe('conformance: 0 pass, 0 fail');
    expect(existsSync(ran)).toBe(true);
  });

  test('a manifest entry whose file is missing is named too', async () => {
    const dir = scratch({
      'conformance.json': JSON.stringify({
        screens: [{ file: 'claude-code/2.1.289/gone.txt', cli: 'claude-code', classify: 'idle', composer: 'idle' }],
        yaml: [{ file: 'yaml/gone.yaml', ok: false }],
      }),
    });
    const ran = marker();
    const result = await run(`touch ${ran}`, dir);
    expect(result.code).toBe(1);
    expect(result.report).toContain('claude-code/2.1.289/gone.txt');
    expect(result.report).toContain('yaml/gone.yaml');
    expect(result.report).toMatch(/conformance: 0 pass, 2 fail$/);
    expect(existsSync(ran)).toBe(false);
  });
});
