// What `doctor` says of a seat whose launch names no model the profile knows: silence only when
// the launch runs the CLI's own binary, bare, and the profile's screen can name the declared
// model; every other shape warns or notes with what the owner can do. The fixture holds one seat
// of each shape; the matrix over launch lines is the review's table. The exact-output test is the
// contract `bun run contract` regenerates.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runApprove } from '../../src/commands/approve.ts';
import { modelFlagFinding, runDoctor, type DoctorSources, type Finding } from '../../src/commands/doctor.ts';
import { profileFor } from '../../src/profiles/index.ts';
import type { Profile } from '../../src/profiles/profile.ts';
import { canShowModel } from '../../src/status/statusline.ts';
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
        'warn  script-seat: the launch runs zsh, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
        'warn  other-model: the launch starts Claude Fable 5.1, the file says Opus 5.5 (dev)',
        'ok    codex codex-cli 0.157.0',
        'ok    codex: logged in',
        'ok    agy 1.2.16',
        'ok    antigravity: logged in',
        'ok    cursor-agent 2026.10.01',
        'ok    cursor: logged in',
        'team doctor: nothing missing, 2 warnings',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(0);
  });

  test('a declared model_from makes the note say what really happens', async () => {
    edit((text) => text.replace('launch: zsh launcher.sh', 'launch: claude\n    model_from: launcher'));
    await approve();
    const run = await doctor();
    // claude-code's screen names the seat's declared model, so the running seat is checked
    expect(run.out).toContain('--    script-seat: the model is chosen by its launcher; checked on the running seat\n');
    expect(run.out).not.toContain('script-seat: the launch');
    expect(run.out).toEndWith('team doctor: nothing missing, 1 warning\n');
  });

  test('an all-correct running team warns only where a version is untested or the owner must act', async () => {
    edit((text) => text.replace('launch: claude --model claude-fable-5-1', 'launch: claude --model claude-opus-5-5'));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({ format: 1, sessions: { pilot: { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat: NOW.toISOString() } } } }),
    );
    const run = await doctor({ sessionRunning: () => true, version: versions('2.2.0 (Claude Code)') });
    const warns = run.out.split('\n').filter((line) => line.startsWith('warn'));
    expect(warns).toEqual([
      'warn  claude 2.2.0 (Claude Code) is newer than the tested 2.1.288: its screens are untested with this version; a seat that isn\'t read at launch is left out, never typed into',
      'warn  script-seat: the launch runs zsh, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
    ]);
    expect(run.out).toContain('ok    the watch is running\n');
    expect(run.out).toEndWith('team doctor: nothing missing, 2 warnings\n');
    expect(run.code).toBe(0);
  });
});

// The review's matrix: every launch-line shape × a model the screen can name or not × model_from
// declared or not. Main printed one warning for every row; this version may fall silent only
// where the launch runs the CLI's own binary, bare, and the screen can name the declared model.
describe('modelFlagFinding', () => {
  const profile = profileFor('claude-code');
  if (!profile) throw new Error('claude-code must have a profile');
  // claude-code's screen names Claude's families; a model another maker spells is unread on it.
  const READABLE: { cli: string; model: string; display: string } = {
    cli: 'claude-code',
    model: 'Claude Opus',
    display: 'Claude Opus 5.5',
  };
  const FOREIGN: { cli: string; model: string; display: string } = {
    cli: 'claude-code',
    model: 'DeepSeek Flash',
    display: 'DeepSeek Flash V4.1',
  };
  const LINES = [
    'claude',
    'VAR=1 claude',
    'env claude',
    'env -i A=1 claude',
    'command claude',
    'exec claude',
    'nice -n 5 claude',
    '/opt/x/claude',
    './claude',
    'claude-wrapper',
    'zsh -c claude',
    'zsh script.sh',
    'npx claude',
    'bunx @scope/claude',
    'echo claude',
  ];
  // The own binary, bare: assignments in front are the pane's environment; anything else — a
  // path, a wrapper, a shell — is another program, and what it does with the model is not this
  // version's to know.
  const BARE = new Set(['claude', 'VAR=1 claude']);
  const seat = (launch: string, shape: typeof READABLE, modelFrom?: 'launcher') => ({
    name: 'one-seat',
    launch,
    ...(modelFrom ? { modelFrom } : {}),
    ...shape,
  });

  test.each(LINES)('%s: bare, wrapped, declared, unread', (line) => {
    // model_from declared: the owner wrote the key, and the note says the truth for the seat
    expect(modelFlagFinding(seat(line, READABLE, 'launcher'), profile)).toEqual({
      level: 'note',
      text: 'one-seat: the model is chosen by its launcher; checked on the running seat',
    });
    expect(modelFlagFinding(seat(line, FOREIGN, 'launcher'), profile)).toEqual({
      level: 'note',
      text: 'one-seat: the model is chosen by its launcher (declared in the file); this version can\'t read DeepSeek Flash V4.1 on this CLI\'s screen, so nothing checks it',
    });
    if (BARE.has(line)) {
      // the own binary: the screen settles it, or nothing can
      expect(modelFlagFinding(seat(line, READABLE), profile)).toBeNull();
      expect(modelFlagFinding(seat(line, FOREIGN), profile)).toEqual({
        level: 'warn',
        text: 'one-seat: no model flag, and this version can\'t read DeepSeek Flash V4.1 on this CLI\'s screen: nothing checks that it runs it',
      });
      return;
    }
    // anything else runs a launcher the file says nothing about: the warning names the repair
    const first = line.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? '';
    const warn: Finding = {
      level: 'warn',
      text: `one-seat: the launch runs ${first}, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher`,
    };
    expect(modelFlagFinding(seat(line, READABLE), profile)).toEqual(warn);
    expect(modelFlagFinding(seat(line, FOREIGN), profile)).toEqual(warn);
  });

  test('no row is silent where main warned unless the running seat is really checked', () => {
    for (const line of LINES) {
      for (const shape of [READABLE, FOREIGN]) {
        for (const declared of [false, true]) {
          const finding = modelFlagFinding(seat(line, shape, declared ? 'launcher' : undefined), profile);
          if (!declared && BARE.has(line) && shape === READABLE) expect(finding).toBeNull();
          else expect(finding).not.toBeNull();
        }
      }
    }
  });

  test('a CLI that starts on its last-used model keeps its warning, bare or not', () => {
    const lastUsed: Pick<Profile, 'binary' | 'lastUsedModel'> = { binary: 'claude', lastUsedModel: true };
    const warn: Finding = {
      level: 'warn',
      text: 'one-seat: the launch names no model this version knows; the file says Claude Opus 5.5',
    };
    expect(modelFlagFinding(seat('claude', READABLE), lastUsed)).toEqual(warn);
    expect(modelFlagFinding(seat('VAR=1 claude', READABLE), lastUsed)).toEqual(warn);
    expect(modelFlagFinding(seat('zsh run.sh', READABLE), lastUsed)).toEqual({
      level: 'warn',
      text: 'one-seat: the launch runs zsh, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
    });
    // the owner's declaration still wins over the CLI's memory
    expect(modelFlagFinding(seat('claude', READABLE, 'launcher'), lastUsed)).toEqual({
      level: 'note',
      text: 'one-seat: the model is chosen by its launcher; checked on the running seat',
    });
  });

  test('what the screen can name comes from the profile: its own families, never another maker', () => {
    expect(canShowModel({ cli: 'claude-code', model: 'Claude Opus' })).toBe(true);
    expect(canShowModel({ cli: 'claude-code', model: 'DeepSeek Flash' })).toBe(false);
    expect(canShowModel({ cli: 'codex', model: 'GPT Sol' })).toBe(true);
    // codex's unreadable-line rule names a group its pattern does not have: it yields nothing
    expect(canShowModel({ cli: 'codex', model: 'Grok' })).toBe(false);
    expect(canShowModel({ cli: 'cursor', model: 'Grok' })).toBe(true);
    expect(canShowModel({ cli: 'antigravity', model: 'Gemini Flash' })).toBe(true);
  });
});
