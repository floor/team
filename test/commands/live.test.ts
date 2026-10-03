import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/commands/approve.ts';
import { realSources as downReal, runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { realSources as upReal, runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { sessionState, type HerdrAgent } from '../../src/herdr.ts';
import { storePath } from '../../src/store/store.ts';
import { readState } from '../../src/state.ts';
import { parseMemoryPressure, parseSwapUsage } from '../../src/watch/machine.ts';
import type { Screen } from '../../src/watch/screen.ts';
import { testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = '❯ \n';
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-live-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const store = () => storePath('acme-web', root, home);

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', now: () => NOW, home });
  expect(code).toBe(0);
}

function agent(name: string, pane: string, status = 'idle'): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
}

function doctor(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

type World = {
  launch: Launch;
  starts: number;
  creates: string[];
  runs: { pane: string; command: string }[];
  renames: string[];
  closes: string[];
  session: 'absent' | 'running' | 'stopped';
  seed(pane: string, text: string, agent: boolean): void;
};

function world(text: string | ((pane: string, label: string) => string) = IDLE): World {
  const state: World = {
    launch: {} as Launch,
    starts: 0,
    creates: [],
    runs: [],
    renames: [],
    closes: [],
    session: 'absent',
    seed(pane, shown, agent) {
      panes.set(pane, { text: shown, agent });
    },
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean }>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.starts++;
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      const shown = typeof text === 'string' ? text : text(pane, label);
      panes.set(pane, { text: shown, agent: false });
      state.creates.push(label);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      state.runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      state.renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      state.closes.push(workspace);
      return true;
    },
    agentPanes() {
      return [...panes].filter(([, pane]) => pane.agent).map(([id]) => id);
    },
    paneText(_session, pane) {
      return panes.get(pane)?.text ?? '';
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return state;
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    ...extra,
  };
}

describe('team up, live', () => {
  test('launches each claude-code seat, names it, and starts the watch', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(made.starts).toBe(1);
    expect(made.creates).toEqual([
      'claude-coordinator-acme',
      'deepseek-acme',
      'deepseek-acme-2',
      'watchdog',
    ]);
    expect(made.renames).toEqual(['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2']);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).toContain('watch: started\n');
    expect(io.out).toContain('skip codex-acme:');
    expect(io.out).toContain('skip grok-acme:');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
    expect(seats['claude-coordinator-acme']?.rules).toBe('option');
    expect(seats['deepseek-acme-2']?.pane).toBe('w3:p1');
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain('watch: started');
  });

  test('a permission prompt closes that workspace and leaves the others', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude-coordinator-acme' ? PERMISSION : IDLE));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: permission; its workspace was closed without input');
    expect(made.closes).toEqual(['w1']);
    expect(made.renames).not.toContain('claude-coordinator-acme');
    expect(made.renames).toContain('deepseek-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
    expect(seats['deepseek-acme']?.stage).toBe('ready');
  });

  test('a seat that never idles stays launched', async () => {
    await approve();
    const made = world('');
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: timed out waiting for its idle prompt; left at launched');
    expect(made.closes).toEqual([]);
    expect(made.renames).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
  });

  test('a recorded pane that is gone is launched again', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'claude-coordinator-acme': { stage: 'launched', pane: 'w9:p1', workspace: 'w9' } },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    const io = testIo(root, { kind: 'owner' });
    await runUp(FILE, io, sources({ sessionState: () => 'running', workspaces: () => [] }, made));
    expect(made.starts).toBe(0);
    expect(made.creates).toContain('claude-coordinator-acme');
    expect(made.runs.some((run) => run.pane === 'w9:p1')).toBe(false);
    expect(made.runs.some((run) => run.pane === 'w1:p1')).toBe(true);
  });

  test('a ready seat is left alone, and a launched one with a live pane is finished', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w8:p1', workspace: 'w8' },
              'deepseek-acme': { stage: 'launched', pane: 'w7:p1', workspace: 'w7' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, true);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [agent('claude-coordinator-acme', 'w8:p1'), agent('deepseek-acme', 'w7:p1')],
          workspaces: () => [{ id: 'w8' }, { id: 'w7' }],
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('skip claude-coordinator-acme: already ready; left as it is');
    expect(made.creates).not.toContain('claude-coordinator-acme');
    expect(made.creates).not.toContain('deepseek-acme');
    expect(made.renames).toContain('deepseek-acme');
    expect(made.renames).not.toContain('claude-coordinator-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['deepseek-acme']?.stage).toBe('ready');
  });

  test('a stopped session is refused and no server is started', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'stopped' }, made));
    expect(code).toBe(1);
    expect(io.err).toContain('herdr session delete acme-web');
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
  });

  test("the approval's ceilings are enforced, not the file's limits", async () => {
    await approve();
    const path = join(store(), 'approval.json');
    const body = JSON.parse(readFileSync(path, 'utf8')) as { ceilings: { seats: number } };
    body.ceilings.seats = 1;
    writeFileSync(path, JSON.stringify(body));
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(made.creates.filter((label) => label !== 'watchdog')).toEqual(['claude-coordinator-acme']);
    expect(io.out).toContain('the approval allows 1 seats; 2 would be running');
  });

  test('a machine past the file refuses before any server starts', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          machine: () => ({ loadPerCore: 9, memoryFree: 80, diskFree: 1e12, swapFree: 1e12, swapUsed: 0 }),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.err).toContain('the load is 9.0 per core, above 3');
    expect(made.starts).toBe(0);
  });

  test("a doctor miss refuses, and the watch's missing heartbeat does not", async () => {
    await approve();
    const missingIo = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run', ...FILE], missingIo, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctor({ version: () => null }),
    });
    expect(missingIo.out).toContain('! up would refuse: install `claude`: it is not on the PATH');

    const heartbeatIo = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run', ...FILE], heartbeatIo, {
      sessionRunning: () => true,
      agents: () => [],
      home,
      doctor: doctor({ sessionRunning: () => true }),
    });
    expect(heartbeatIo.out).not.toContain('! up would refuse');
    expect(heartbeatIo.out).not.toContain('no watch has run');
  });
});

describe('team down, live', () => {
  function seat(status = 'idle'): HerdrAgent {
    return agent('deepseek-acme', 'w3:p1', status);
  }

  function harness(screen: Screen, status = 'idle') {
    const typed: string[] = [];
    const entered: string[] = [];
    const closed: string[] = [];
    const killed: number[] = [];
    const stopped: string[] = [];
    let clock = NOW.getTime();
    let gone = false;
    let current = status;
    let onSleep = () => {};
    const launch: DownLaunch = {
      typeText(_session, _pane, text) {
        typed.push(text);
        return true;
      },
      pressEnter() {
        entered.push('enter');
        gone = true;
        return true;
      },
      agentPanes: () => (gone ? [] : ['w3:p1']),
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      stopSession(session) {
        stopped.push(session);
        return true;
      },
      kill(pid) {
        killed.push(pid);
        return true;
      },
      sleep: async (ms) => {
        clock += ms;
        onSleep();
      },
      now: () => new Date(clock),
    };
    const sourcesOf = (overrides: Partial<DownSources> = {}): DownSources => ({
      sessionRunning: () => true,
      agents: () => [seat(current)],
      alive: () => false,
      screen: () => screen,
      status: () => current,
      now: () => new Date(clock),
      sleep: launch.sleep,
      launch,
      ...overrides,
    });
    return {
      typed,
      entered,
      closed,
      killed,
      stopped,
      launch,
      sourcesOf,
      setStatus: (value: string) => {
        current = value;
      },
      onSleep: (hook: () => void) => {
        onSleep = hook;
      },
    };
  }

  test('types the exit only when the screen is idle, then closes the workspace', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('holds Enter when the status turns working after the text', async () => {
    const run = harness({ kind: 'idle' });
    let looks = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(
      FILE,
      io,
      run.sourcesOf({
        status: () => {
          looks += 1;
          return looks === 1 ? 'idle' : 'working';
        },
      }),
    );
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not typed; left as it is\n');
  });

  test('does not type into a permission prompt', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('is blocked at a prompt');
  });

  test('a seat that does not leave is left as it is', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.agentPanes = () => ['w3:p1'];
    run.launch.typeText = () => true;
    run.launch.pressEnter = () => true;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: timed out leaving its pane; left as it is');
    expect(io.out).toContain('session acme-web: not stopped, something was left in it');
  });

  test('the owner can abandon a blocked seat without typing', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--abandon', ...FILE], io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('--wait holds a working seat until it is free', async () => {
    const run = harness({ kind: 'idle' }, 'working');
    let waits = 0;
    run.onSleep(() => {
      waits++;
      run.setStatus('idle');
    });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--wait', ...FILE], io, run.sourcesOf());
    expect(waits).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
  });
});

const SCRATCH = 'team-test-up';

// A new folder makes Claude show its trust dialog. `up` treats that as a permission
// prompt and closes the workspace without typing. Mark the scratch folder trusted for
// this run, and take the mark back afterwards. The rest of the file is left as it was.
function trustScratch(path: string): () => void {
  const file = join(homedir(), '.claude.json');
  const before = readFileSync(file, 'utf8');
  const key = JSON.stringify(path);
  if (before.includes(key)) return () => {};
  const at = before.indexOf('"projects"');
  const brace = before.indexOf('{', at);
  if (at < 0 || brace < 0) throw new Error('claude config has no projects map; not starting a session');
  const insert = `\n    ${key}: {"hasTrustDialogAccepted": true},`;
  writeFileSync(file, before.slice(0, brace + 1) + insert + before.slice(brace + 1));
  return () => {
    const now = readFileSync(file, 'utf8');
    const at = now.indexOf(key);
    if (at < 0) return;
    // Claude rewrites the entry while it runs, so the inserted line is gone and the
    // object has grown. Drop the whole value and keep the rest of the file byte for byte.
    const brace = now.indexOf('{', at + key.length);
    if (brace < 0) return;
    let depth = 0;
    let end = brace;
    for (; end < now.length; end++) {
      const ch = now[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    let start = at;
    while (start > 0 && (now[start - 1] === ' ' || now[start - 1] === '\t')) start--;
    if (start > 0 && now[start - 1] === '\n') start--;
    let stop = end;
    if (now[stop] === ',') stop++;
    if (now[stop] === '\n') stop++;
    const next = now.slice(0, start) + now.slice(stop);
    const parsed = JSON.parse(next) as { projects?: Record<string, unknown> };
    if (parsed.projects && path in parsed.projects) return;
    writeFileSync(file, next);
  };
}

describe('scratch session', () => {
  // Opt-in: CI has no herdr. Never team-test, which is another seat's session.
  test.skipIf(process.env.TEAM_LIVE_UP !== '1')(
    'launches one cheap seat and stops it',
    async () => {
      const uptime = execFileSync('uptime', { encoding: 'utf8' });
      const load = Number(/load averages?: ([\d.]+)/.exec(uptime)?.[1] ?? '99');
      if (!(load < 60)) throw new Error(`load is ${load}; not starting a session`);
      const pressure = execFileSync('memory_pressure', { encoding: 'utf8' });
      const memory = parseMemoryPressure(pressure);
      if (memory === null || memory < 25) throw new Error(`free memory is ${memory}%; not starting a session`);
      const readSwap = () => parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }));
      const first = readSwap();
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      const second = readSwap();
      if (!first || !second) throw new Error('swap could not be read; not starting a session');
      if (second.used > first.used) {
        throw new Error(`swap used grew from ${first.used} to ${second.used}; not starting a session`);
      }

      const before = sessionState(SCRATCH);
      if (before !== 'absent') throw new Error(`session ${SCRATCH} is ${before}; not touching it`);

      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'team-scratch-')));
      const project = join(scratch, 'acme-web');
      const scratchHome = join(scratch, 'home');
      mkdirSync(join(project, '.agents'), { recursive: true });
      mkdirSync(scratchHome);
      let untrust = () => {};
      untrust = trustScratch(realpathSync(project));
      // One claude-code seat, on the cheapest model. The example's DeepSeek seats are the
      // other claude-code seats, so they are left out. Nothing is sent beyond that launch;
      // down's exit is the teardown. The file's own gate still refuses on free swap, and this
      // run is allowed when swap has not grown, so the scratch file sets a floor under the
      // free figure and a load ceiling of 60.
      const deepseek = [
        '  - role: implementer',
        '    name: deepseek-acme',
        '    cli: claude-code           # DeepSeek\'s model, run by Claude Code',
        '    vendor: deepseek',
        '    model: DeepSeek Flash',
        '    version: "V4.1"',
        '    display: DeepSeek V4.1 Flash',
        '    launch: team-deepseek',
        '    count: 2                   # deepseek-acme, deepseek-acme-2',
        '',
      ].join('\n');
      const cheap = EXAMPLE.replace('session: acme-web', `session: ${SCRATCH}`)
        .replace('model: Claude Opus', 'model: Claude Haiku')
        .replace('version: "5.5"', 'version: "4.5"')
        .replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-haiku-4-5-20251001')
        .replace('  load_start: 3.0', '  load_start: 60')
        .replace(
          '  disk_min: 10GB               # free on the project\'s volume; both refuse and report',
          '  disk_min: 10GB               # free on the project\'s volume; both refuse and report\n  swap_free_min: 1MB',
        )
        .replace(deepseek, '');
      if (cheap.includes('deepseek-acme') || !cheap.includes('claude-haiku-4-5-20251001')) {
        throw new Error('the scratch file is not the one cheap claude-code seat');
      }
      writeFileSync(join(project, '.agents/team.yaml'), cheap);
      const file = ['--file', join(project, '.agents/team.yaml')];
      const owner = testIo(project, { kind: 'owner' });
      try {
        expect(await runApprove(file, owner, { ask: async () => '3', now: () => new Date(), home: scratchHome })).toBe(0);
        const doctor = upReal.doctor ? { ...upReal.doctor, home: scratchHome } : undefined;
        const upCode = await runUp(file, owner, { ...upReal, home: scratchHome, doctor });
        expect(upCode).toBe(0);
        const downCode = await runDown(file, owner, downReal);
        if (downCode !== 0) throw new Error(`down left this:\n${owner.out}\n${owner.err}`);
      } finally {
        const left = sessionState(SCRATCH);
        if (left === 'running' || left === 'stopped') {
          try {
            execFileSync('herdr', ['session', 'stop', SCRATCH], { stdio: 'ignore' });
          } catch {
            // already stopped
          }
          try {
            execFileSync('herdr', ['session', 'delete', SCRATCH], { stdio: 'ignore' });
          } catch {
            // the test reports the failure above; the session is named so it can be cleared by hand
          }
        }
        untrust();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
