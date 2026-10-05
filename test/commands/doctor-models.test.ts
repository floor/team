// What `doctor` says of a seat whose launch names no model the profile knows: a launcher script
// or program gets a note (the model is checked on the running seat), a CLI that keeps no model on
// its screen keeps a warning, and the version warnings say what an untested version means. The
// fixture holds one seat of each shape; the exact-output test is the contract `bun run contract`
// regenerates.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runApprove } from '../../src/commands/approve.ts';
import { modelFlagFinding, runDoctor, type DoctorSources, type Finding } from '../../src/commands/doctor.ts';
import type { Profile } from '../../src/profiles/profile.ts';
import { installKey } from '../../src/store/keys.ts';
import { testIo } from '../helpers.ts';

const FIXTURE = readFileSync(join(import.meta.dir, '../fixtures/doctor-models.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-03T14:02:00Z');

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-models-')));
  root = join(base, 'pilot');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), FIXTURE);
});

// The whole file is thrown away with the temporary directory it was written in.
afterEach(() => rmSync(base, { recursive: true, force: true }));

const edit = (change: (text: string) => string) =>
  writeFileSync(join(root, '.agents/team.yaml'), change(readFileSync(join(root, '.agents/team.yaml'), 'utf8')));

async function approve() {
  const io = testIo(root, OWNER);
  return runApprove(FILE, io, { ask: async () => '7', now: () => NOW, home });
}

// Every CLI at its tested version, claude overridable to one past the range.
const versions = (claude: string) => (binary: string): string | null =>
  binary === 'claude'
    ? claude
    : binary === 'codex'
      ? 'codex-cli 0.157.0'
      : binary === 'agy'
        ? '1.2.16'
        : binary === 'cursor-agent'
          ? '2026.10.01'
          : null;

function sources(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: versions('2.1.288 (Claude Code)'),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

async function doctor(overrides: Partial<DoctorSources> = {}) {
  const io = testIo(root, OWNER);
  const code = await runDoctor([...FILE], io, sources(overrides));
  return { code, out: io.out, err: io.err };
}

describe('team doctor on a file of every model shape', () => {
  test('the seven seats, exactly', async () => {
    await approve();
    const run = await doctor();
    expect(run.err).toBe('');
    expect(run.out).toBe(
      [
        'ok    the file is the one the owner approved (approval #1, 2026-10-03, key fe21ef6293de)',
        'ok    herdr 0.7.1',
        '--    session pilot is not running',
        'ok    claude 2.1.288 (Claude Code)',
        'ok    claude-code: logged in',
        '--    script-seat: the model is chosen by its launcher; checked on the running seat',
        'warn  other-model: the launch starts Claude Fable 5.1, the file says Opus 5.5 (dev)',
        'ok    codex codex-cli 0.157.0',
        'ok    codex: logged in',
        'ok    agy 1.2.16',
        'ok    antigravity: logged in',
        'ok    cursor-agent 2026.10.01',
        'ok    cursor: logged in',
        'team doctor: nothing missing, 1 warning',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(0);
  });

  test('a declared model_from beats the launch line the seat runs', async () => {
    edit((text) => text.replace('launch: zsh launcher.sh', 'launch: claude\n    model_from: launcher'));
    await approve();
    const run = await doctor();
    expect(run.out).toContain('--    script-seat: the model is chosen by its launcher; checked on the running seat\n');
    expect(run.out).not.toContain('script-seat: the launch');
  });

  test('an all-correct running team warns only where this version cannot check', async () => {
    edit((text) => text.replace('launch: claude --model claude-fable-5-1', 'launch: claude --model claude-opus-5-5'));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({ format: 1, sessions: { pilot: { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat: NOW.toISOString() } } } }),
    );
    const run = await doctor({ sessionRunning: () => true });
    const warns = run.out.split('\n').filter((line) => line.startsWith('warn'));
    expect(warns).toEqual([]);
    expect(run.out).toContain('ok    the watch is running\n');
    expect(run.out).toEndWith('team doctor: nothing missing, 0 warnings\n');
    expect(run.code).toBe(0);
  });
});

// The branches no shipped profile reaches: a CLI whose screen shows no model, and one that starts
// on its last-used model — the second is another change's to reword, so its text is pinned here.
describe('modelFlagFinding', () => {
  const seat = (over: Partial<Parameters<typeof modelFlagFinding>[0]>) => ({
    name: 'one-seat',
    launch: 'claude',
    display: 'Opus 5.5 (dev)',
    ...over,
  });
  const profile = (over: Partial<Pick<Profile, 'binary' | 'processNames' | 'readsModel' | 'lastUsedModel'>>) => ({
    binary: 'claude',
    processNames: ['claude'],
    readsModel: true,
    lastUsedModel: false,
    ...over,
  });

  test('a CLI that shows no model keeps a warning that says so', () => {
    expect(modelFlagFinding(seat({}), profile({ readsModel: false }))).toEqual({
      level: 'warn',
      text: 'one-seat: no model flag and this CLI doesn\'t show its model; nothing checks that it runs Opus 5.5 (dev)',
    });
  });

  test('a launcher script or program gets a note; the declared key says so even for the bare binary', () => {
    const note: Finding = { level: 'note', text: 'one-seat: the model is chosen by its launcher; checked on the running seat' };
    expect(modelFlagFinding(seat({ launch: 'zsh launcher.sh' }), profile({}))).toEqual(note);
    expect(modelFlagFinding(seat({ launch: 'team-deepseek' }), profile({}))).toEqual(note);
    expect(modelFlagFinding(seat({ launch: '/usr/local/bin/team-deepseek' }), profile({}))).toEqual(note);
    expect(modelFlagFinding(seat({ modelFrom: 'launcher' }), profile({}))).toEqual(note);
  });

  test('the CLI\'s own binary with no flag is checked on the running seat: nothing to say', () => {
    expect(modelFlagFinding(seat({}), profile({}))).toBeNull();
    expect(modelFlagFinding(seat({ launch: '/usr/local/bin/claude' }), profile({}))).toBeNull();
    expect(modelFlagFinding(seat({ launch: 'env ANTHROPIC_X=1 claude' }), profile({}))).toBeNull();
  });

  test('a CLI that starts on its last-used model keeps its warning', () => {
    expect(modelFlagFinding(seat({}), profile({ lastUsedModel: true }))).toEqual({
      level: 'warn',
      text: 'one-seat: the launch names no model this version knows; the file says Opus 5.5 (dev)',
    });
  });
});
