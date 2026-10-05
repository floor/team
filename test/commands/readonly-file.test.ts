// A command that only reads must not write into a project its caller has nothing to do with.
// `status --file <another project's team.yaml>` opened that file and left a new
// `.agents/team.state.json` beside it, its `last_valid` holding the file's own bytes; `watch
// --file` did the same and more (its log line, its heartbeat, its readings) — from a command
// whose own page says "It writes nothing". The rule the commands that change a team already hold
// (`--file is the owner's`, decided by the walk alone, before that file is read) is the smaller
// of the two fixes: nothing legitimate carries the flag as a non-owner — the watch pane `up`
// starts runs `team watch --session <name>` from the project root, never `--file`, and a seat's
// `status` finds the file through the git walk — so the refusal breaks no one, and the probes
// below hold the other read-and-report commands (`doctor`, `check`, `release check`, and the
// owner's `approve` and `up`; `init` takes no flag) to the same: nothing written beside a
// foreign file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { placeCaller, type Caller, type CallerSources } from '../../src/caller.ts';
import { runApprove } from '../../src/commands/approve.ts';
import { check, loadConfig } from '../../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runInit } from '../../src/commands/init.ts';
import { runRelease } from '../../src/commands/release.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import type { Fetch } from '../../src/release/http.ts';
import { storePath, writeApproval, type Standing } from '../../src/store/store.ts';
import { testIo, type TestIo } from '../helpers.ts';

const SESSION = 'acme-web';
const OTHER = 'other-web';
const COORDINATOR = 'claude-coordinator-acme';
const OPERATOR = 'claude-operator-acme';
const SEAT = 'codex-acme';
const COORDINATOR_PANE = 'w1:p1';

const FILE = `format: 1
project: acme
session: ${SESSION}
coordinator: ${COORDINATOR}
operator: ${OPERATOR}
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: ${COORDINATOR}
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: ${OPERATOR}
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: ${SEAT}
    label: codex
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;

const STATE = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: {
        [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE },
        [OPERATOR]: { stage: 'ready', pane: 'w4:p1' },
        [SEAT]: { stage: 'ready', pane: 'w3:p1' },
      },
      worktrees: {},
    },
  },
};

let base: string;
let dir: string;
let file: string;
let stateFile: string;
let home: string;
let emptyHome: string;
let fileText: string;

beforeEach(() => {
  // The world of test/commands/coordinator-session.test.ts, trimmed to what a read needs: a
  // project with a valid, approved team file and a state that records every seat, and a home
  // whose lobby exists so the file's trust entries land.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-readonly-file-')));
  dir = join(base, 'project');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  file = join(dir, '.agents', 'team.yaml');
  stateFile = join(dir, '.agents', 'team.state.json');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  home = join(base, 'home');
  emptyHome = join(base, 'home-empty');
  mkdirSync(lobbyDir(home), { recursive: true });
  chmodSync(lobbyDir(home), 0o700);
  fileText = `${FILE}trust:\n  - ~/.config/team/lobby\n  - ${dir}\n`;
  writeFileSync(file, fileText);
  const loaded = loadTeamFile(dir, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: fileText },
    loaded.team.seats,
    home,
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runningAgent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? '', status: 'idle', cwd: null };
}

// A caller placed by fake sources, as coordinator-session.test.ts places them: a seat of another
// session is the non-owner every refusal below meets.
function placed(session: string, name: string | null, pane: string): Caller {
  const row = runningAgent(name ?? '', pane);
  const sources: CallerSources = {
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => [row],
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  };
  return placeCaller(sources, session);
}

// The fake sources a real run reads for a caller under herdr, answering for the session asked
// about: a command that read a session before its refusal places a seat of it, and a command
// that read none places nobody.
function sourcesUnderHerdr(session: string, name: string, pane: string): (asked: string | undefined) => CallerSources {
  const row = runningAgent(name, pane);
  return (asked) => ({
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => (asked === session ? [row] : []),
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  });
}

// The states a flagged path stands in, one test each (coordinator-session.test.ts's set): no
// file at all, an unparsable file, a valid team file, a folder, an unreadable file. The refusal
// is the same bytes and the same exit in all five.
const FLAGGED_STATES: { name: string; setUp: (path: string) => void; seal?: (path: string) => void; open?: (path: string) => void }[] = [
  { name: 'missing', setUp: () => {} },
  { name: 'unparsable', setUp: (path) => writeFileSync(path, 'format: [\n') },
  { name: 'valid', setUp: (path) => writeFileSync(path, FILE) },
  { name: 'a folder', setUp: (path) => mkdirSync(path) },
  { name: 'unreadable', setUp: (path) => writeFileSync(path, FILE), seal: (path) => chmodSync(path, 0o000), open: (path) => chmodSync(path, 0o600) },
];

function flaggedProject(stateName = 'valid'): {
  root: string;
  file: string;
  listing: () => string[];
  bytes: () => string | null;
  seal: () => void;
  open: () => void;
  cleanup: () => void;
} {
  const state = FLAGGED_STATES.find((one) => one.name === stateName);
  if (!state) throw new Error(`no flagged state named ${stateName}`);
  const root = mkdtempSync(join(tmpdir(), 'team-flagged-'));
  mkdirSync(join(root, '.agents'));
  const flagged = join(root, '.agents', 'team.yaml');
  state.setUp(flagged);
  return {
    root,
    file: flagged,
    listing: () => readdirSync(join(root, '.agents')).sort(),
    bytes: () => {
      try {
        return readFileSync(flagged, 'utf8');
      } catch {
        return null;
      }
    },
    seal: () => state.seal?.(flagged),
    open: () => state.open?.(flagged),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function statusSources(over: Partial<StatusSources> = {}): StatusSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {}, processes: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }) as Standing,
    now: () => new Date(0),
    home,
    ...over,
  };
}

function watchSources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {}, processes: {} }),
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapFree: 8e9, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }) as Standing,
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    notify: () => {},
    now: () => new Date(0),
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
    ...over,
  };
}

function upSources(over: Partial<UpSources> = {}): UpSources {
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    home,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => new Date(0),
      home,
    },
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapFree: 8e9, swapUsed: 0 }),
    now: () => new Date(0),
    sleep: async () => {},
    alive: () => false,
    ...over,
  };
}

const NO_FETCH: Fetch = async () => {
  throw new Error('no network in this test');
};

const FILE_OWNER = (command: string, who: string) =>
  `team ${command}: --file is the owner's, from a terminal outside herdr; this call is ${who}\n`;

// Every run starts from the file and the state as written, so a run's writes are told from the
// bytes it started from.
type Run = { code: number; out: string; err: string; before: string; beforeState: string };

async function call(runner: (io: TestIo) => Promise<number>, caller: Caller): Promise<Run> {
  writeFileSync(file, fileText);
  writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');
  const beforeState = readFileSync(stateFile, 'utf8');
  const io = testIo(dir, caller);
  const code = await runner(io);
  return { code, out: io.out, err: io.err, before, beforeState };
}

// The runner's own io, for the runs the assertions read the output of.
async function outputOf(runner: (io: TestIo) => Promise<number>, caller?: Caller): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(dir, caller);
  const code = await runner(io);
  return { code, out: io.out, err: io.err };
}

// The rule, against one state of the flagged path: the walk refuses the flag before the file is
// read — the run places nobody, because placing a caller would read a session — and neither
// project moves: the flagged project's folder listing and every file's bytes unchanged, the
// caller's own project's file, state and log unchanged too.
async function refusedBeforeRead(command: 'status' | 'watch', stateName: string): Promise<void> {
  const flagged = flaggedProject(stateName);
  try {
    const beforeListing = flagged.listing();
    const beforeBytes = flagged.bytes();
    flagged.seal();
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const before = readFileSync(file, 'utf8');
    const beforeState = readFileSync(stateFile, 'utf8');
    const io = testIo(dir);
    io.callerSources = sourcesUnderHerdr(OTHER, COORDINATOR, COORDINATOR_PANE);
    const argv = ['--file', flagged.file];
    const code = command === 'status'
      ? await runStatus(argv, io, statusSources())
      : await runWatch(argv, io, watchSources());
    flagged.open();
    expect({ code, out: io.out, err: io.err }).toEqual({
      code: 1,
      out: '',
      err: FILE_OWNER(command, 'unplaced (it runs under herdr)'),
    });
    expect(flagged.listing()).toEqual(beforeListing);
    expect(flagged.bytes()).toBe(beforeBytes);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(stateFile, 'utf8')).toBe(beforeState);
    expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
    expect(existsSync(join(flagged.root, '.agents', 'team.log'))).toBe(false);
  } finally {
    flagged.cleanup();
  }
}

for (const command of ['status', 'watch'] as const) {
  describe(`${command}: --file is the owner's`, () => {
    // The reported write, as the failing test first: a non-owner's `--file` against a valid file
    // of another project. On main `status` answers as a reader and leaves a new
    // `team.state.json` beside that file, its `last_valid` holding the file's own bytes; `watch`
    // answers as a reader and leaves the state file, its log line, its heartbeat and its
    // readings there.
    test("a non-owner's --file against a valid foreign file is refused, and writes nothing", async () => {
      const flagged = flaggedProject('valid');
      try {
        const beforeListing = flagged.listing();
        const run = await call((io) =>
          command === 'status'
            ? runStatus(['--file', flagged.file], io, statusSources())
            : runWatch(['--file', flagged.file], io, watchSources()), placed(OTHER, COORDINATOR, COORDINATOR_PANE));
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({
          code: 1,
          out: '',
          err: FILE_OWNER(command, COORDINATOR),
        });
        expect(flagged.listing()).toEqual(beforeListing);
        expect(readFileSync(file, 'utf8')).toBe(run.before);
        expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
        expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
        expect(existsSync(join(flagged.root, '.agents', 'team.log'))).toBe(false);
      } finally {
        flagged.cleanup();
      }
    });

    // The same refusal through the sources a real run reads: decided by the walk alone, so the
    // same bytes and the same exit whatever is at the flagged path — no `no team file at …`, no
    // YAML problem, no report — and no session is read on the way (the fixture would answer for
    // its own, and nothing asks).
    for (const state of FLAGGED_STATES) {
      test(`the walk alone refuses it, before the file is read: the flagged path is ${state.name}`, async () => {
        await refusedBeforeRead(command, state.name);
      });
    }

    test('the owner may aim --file: the gate lets it through', async () => {
      writeFileSync(file, fileText);
      writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
      const sources = command === 'status' ? statusSources() : watchSources();
      const flagged = command === 'status'
        ? await outputOf((io) => runStatus(['--file', file], io, sources as StatusSources), { kind: 'owner' })
        : await outputOf((io) => runWatch(['--file', file], io, sources as WatchSources), { kind: 'owner' });
      writeFileSync(file, fileText);
      writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
      const plain = command === 'status'
        ? await outputOf((io) => runStatus([], io, sources as StatusSources), { kind: 'owner' })
        : await outputOf((io) => runWatch([], io, sources as WatchSources), { kind: 'owner' });
      expect(flagged).toEqual(plain);
    });
  });
}

// The watch the pane runs carries no flag, and a seat's `status` needs none: the refusal the
// rule adds breaks neither. `up --file` starts its watch from the project root, the line built
// by `watchCommand` (`team watch`, `--session` when the session is not "default"), and the pane
// that runs it is under herdr — a caller the walk places as unplaced, exactly the caller the
// rule must not refuse when no flag is passed.
describe('a team whose owner ran up --file', () => {
  test('the watch it starts carries no --file, and that watch runs from a pane under herdr', async () => {
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const lines: string[] = [];
    const agents = () => [runningAgent(COORDINATOR, COORDINATOR_PANE), runningAgent(OPERATOR, 'w4:p1'), runningAgent(SEAT, 'w3:p1')];
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'w9:p1', workspace: 'w9' }),
      paneRun: (_session, _pane, command) => {
        lines.push(command);
        return true;
      },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents,
      paneText: () => null,
      foreground: () => null,
      sleep: async () => {},
      now: () => new Date(0),
    };
    const code = await runUp(['--file', '.agents/team.yaml'], testIo(dir, { kind: 'owner' }), upSources({
      launch,
      agents,
      workspaces: () => [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
    }));
    expect(code).toBe(0);
    const watchLine = lines.find((line) => line.includes(' watch'));
    expect(watchLine).toBeDefined();
    expect(watchLine).toContain('--session');
    expect(watchLine).not.toContain('--file');

    // The pane's own run: a caller under herdr (the walk places nobody — naming a seat would
    // read a session), no flag, the session named. The watch starts.
    const pane = await outputOf((io) => {
      io.callerSources = sourcesUnderHerdr(OTHER, COORDINATOR, COORDINATOR_PANE);
      return runWatch(['--session', SESSION], io, watchSources());
    });
    expect(pane.code).toBe(0);
    expect(pane.out).toContain(`watching the session "${SESSION}"`);
  });

  test("its seats' status still works in their own project: no flag, the same report the owner reads", async () => {
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const seat = await outputOf((io) => runStatus([], io, statusSources()), {
      kind: 'seat',
      name: COORDINATOR,
      pane: COORDINATOR_PANE,
      session: SESSION,
    });
    writeFileSync(file, fileText);
    writeFileSync(stateFile, `${JSON.stringify(STATE, null, 2)}\n`);
    const owner = await outputOf((io) => runStatus([], io, statusSources()), { kind: 'owner' });
    expect(seat).toEqual(owner);
    expect(seat.code).toBe(1);
    // And its own project's state holds the fallback copy, as before: a project's own readers
    // still record `last_valid` — the copy `status`, `watch` and `down` fall back to while the
    // owner edits the file — in the one project that is theirs.
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { last_valid?: { file?: string } };
    expect(state.last_valid?.file).toBe(fileText);
  });
});

// Every other command that takes `--file`, held to the same rule: whatever it answers, a
// non-owner's run writes nothing beside the flagged file and nothing in its own project. The
// commands that change a team already refuse the flag before the file is read
// (coordinator-session.test.ts); these are the readers, and the owner's two.
describe('the other commands that take --file: nothing written beside a foreign file', () => {
  async function writesNothingBesideTheFlaggedFile(make: (flaggedFile: string) => (io: TestIo) => Promise<number>): Promise<void> {
    const flagged = flaggedProject('valid');
    try {
      const beforeListing = flagged.listing();
      const beforeBytes = flagged.bytes();
      const run = await call(make(flagged.file), placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      expect(flagged.listing()).toEqual(beforeListing);
      expect(flagged.bytes()).toBe(beforeBytes);
      expect(readFileSync(file, 'utf8')).toBe(run.before);
      expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
      expect(existsSync(join(dir, '.agents', 'team.log'))).toBe(false);
      expect(existsSync(join(flagged.root, '.agents', 'team.log'))).toBe(false);
    } finally {
      flagged.cleanup();
    }
  }

  test('doctor reads it and writes nothing', async () => {
    const sources: DoctorSources = {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      agentList: () => [],
      now: () => new Date(0),
      home,
    };
    await writesNothingBesideTheFlaggedFile((flaggedFile) => (io) => runDoctor(['--file', flaggedFile], io, sources));
  });

  test('check reads it and writes nothing', async () => {
    await writesNothingBesideTheFlaggedFile(
      (flaggedFile) => (io) => check(['HEAD', '--file', flaggedFile], io, (cwd, path) => loadConfig(cwd, path, home)),
    );
  });

  test('release check reads it and writes nothing', async () => {
    await writesNothingBesideTheFlaggedFile(
      (flaggedFile) => (io) => runRelease(['check', 'acme-web@1.0.0', '--file', flaggedFile], io, NO_FETCH),
    );
  });

  test('approve: the owner gate holds before any write', async () => {
    await writesNothingBesideTheFlaggedFile(
      (flaggedFile) => (io) => runApprove(['--file', flaggedFile], io, { ask: async () => null, now: () => new Date(0), home }),
    );
  });

  test('up: the owner refusal holds before any write', async () => {
    await writesNothingBesideTheFlaggedFile((flaggedFile) => (io) => runUp(['--file', flaggedFile], io, upSources()));
  });

  test('init takes no --file at all', async () => {
    await writesNothingBesideTheFlaggedFile((flaggedFile) => (io) => runInit(['--file', flaggedFile], io, emptyHome));
  });
});
