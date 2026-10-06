// A real pty and the real `team approve`: the paste guard, end to end, on the platform running
// the suite. The guard reads /dev/tty, and /dev/tty only resolves when the caller has a
// controlling terminal, so the run goes through test/commands/pty-run.py (pty.fork(); see that
// file for why not `script(1)`: its macOS dialect aborts on the runner's socket stdin).
//
// The guard sits after the caller walk, so the proof needs a caller the walk places as the
// owner: CI's runner ancestry is clean, and so is a launchd-parented run. Run inside an agent,
// the walk refuses earlier with `approve.not-owner`; the test then says so and checks the
// refusal order instead of pretending to have reached the guard. That order is a rule of its
// own: an earlier refusal wins, and the guard must not eat a line on its way to one.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installKey } from '../../src/store/keys.ts';
import { findStore } from '../../src/store/store.ts';

const REPO = join(import.meta.dir, '..', '..');
const DRIVER = join(import.meta.dir, 'pty-run.py');
const EXAMPLE = readFileSync(join(import.meta.dir, '..', 'fixtures', 'example.yaml'), 'utf8');
// No trailing newline: the pty's line discipline turns it into \r\n on the way out.
const GUARD = 'team approve: input was waiting on the terminal: run `team approve` on its own line';
const STRANGER = 'team approve: only the owner approves a team file';

type Ran = { exit: number | null; signal?: number; out: string; killed: boolean };

function runInPty(command: string[], cwd: string, env: Record<string, string>, write: string | null): Ran {
  const argv = ['python3', DRIVER, ...(write === null ? [] : ['--write', write]), '--', ...command];
  let raw: string;
  let rawErr: string;
  let exitCode: number | null;
  try {
    const proc = Bun.spawnSync(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    raw = proc.stdout?.toString() ?? '';
    rawErr = proc.stderr?.toString() ?? '';
    exitCode = proc.exitCode ?? null;
  } catch (error) {
    throw new Error(`the pty proof needs python3 on PATH: ${error}`);
  }
  if (exitCode !== 0 || !raw.trim()) {
    throw new Error(`pty-run.py could not run (exit ${exitCode}): ${rawErr}`);
  }
  return JSON.parse(raw) as Ran;
}

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pty-')));
  root = join(base, 'example');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
  // The fixed fixture key, so an approval this test writes signs with the same key on every
  // machine and never touches the real ~/.config.
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'key.json'), 'utf8')));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const command = () => [process.execPath, join(REPO, 'src/cli.ts'), 'approve'];
const env = () => ({ HOME: home, PATH: process.env.PATH ?? '' });

function stranger(resp: Ran): boolean {
  if (resp.out.includes(STRANGER)) {
    console.log('pty-guard: this environment places the caller as a stranger (an agent runs the suite); ' +
      'the guard is proven where the ancestry is clean (CI, launchd), and the refusal order is checked here instead.');
    return true;
  }
  return false;
}

test('a line waiting on the pty: the guard refuses, exit 1, nothing written', () => {
  const resp = runInPty(command(), root, env(), '9\n');
  if (stranger(resp)) {
    expect(resp.out).toContain(STRANGER);
    expect(resp.out).not.toContain(GUARD);
    return;
  }
  expect(resp.killed).toBe(false);
  expect(resp.out).toContain(GUARD);
  expect(resp.exit).toBe(1);
  expect(findStore(root, home)).toBeNull();
}, 30_000);

test('nothing waiting: the guard is silent and the run approves', () => {
  const resp = runInPty(command(), root, env(), null);
  if (stranger(resp)) {
    expect(resp.out).toContain(STRANGER);
    expect(resp.out).not.toContain(GUARD);
    return;
  }
  expect(resp.killed).toBe(false);
  expect(resp.out).not.toContain(GUARD);
  expect(resp.out).toContain('Approved.');
  expect(resp.exit).toBe(0);
  const store = findStore(root, home);
  expect(store).not.toBeNull();
  expect(existsSync(join(store as string, 'approval.json'))).toBe(true);
}, 30_000);
