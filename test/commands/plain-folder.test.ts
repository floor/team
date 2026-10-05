// A folder with no git repository: flagless load reads `.agents/team.yaml` there and nowhere
// above it, `up` starts a watch only when that watch would read the file it was given, and the
// caller gate and the approval still decide once the file is found.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { check, loadConfig } from '../../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, WATCH_NOT_STARTED, watchWouldRead, type Launch, type UpSources } from '../../src/commands/up.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { storePath, writeApproval, type Standing } from '../../src/store/store.ts';
import { readState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function fresh(): { base: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-plain-')));
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  chmodSync(lobbyDir(home), 0o700);
  return { base, home };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function teamText(root: string): string {
  return `format: 1
project: acme
session: ${SESSION}
coordinator: claude-coordinator-acme
operator: claude-operator-acme
workspace:
  mode: shared
  base: main
trust:
  - ~/.config/team/lobby
  - ${root}
watch:
  interval: 120s
  checks:
    extra: off
    team-idle: off
    load: off
    memory: off
    disk: off
    swap-free: off
    swap-growth: off
    budget: off
    idle: off
    unsent: off
    restored: off
seats:
  - role: coordinator
    name: claude-coordinator-acme
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: claude-operator-acme
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

function approve(cwd: string, file: string, home: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(cwd, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): { launch: Launch; creates: { label: string; cwd: string }[]; runs: { pane: string; command: string }[] } {
  const creates: { label: string; cwd: string }[] = [];
  const runs: { pane: string; command: string }[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: IDLE, agent: false });
      creates.push({ label, cwd });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { launch, creates, runs };
}

function upSources(home: string, made: ReturnType<typeof world>): UpSources {
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor: doctor(home),
    launch: made.launch,
  };
}

function statusSources(home: string): StatusSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {}, processes: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }) as Standing,
    now: () => NOW,
    home,
  };
}

function watchSources(home: string): WatchSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {}, processes: {} }),
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
    now: () => NOW,
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
  };
}

function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(home),
    now: () => NOW,
    launch: world().launch,
  };
}

/** The recorded pane command, run as the pane runs it: a shell, cwd the watchdog's start folder. */
function runAsPane(command: string, cwd: string, home: string): Promise<{ pid: number; heartbeat: string }> {
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh
if [ "$1" = session ] && [ "$2" = list ]; then
  printf '%s\\n' '{"sessions":[]}'
  exit 0
fi
exit 1
`);
  chmodSync(join(bin, 'herdr'), 0o755);
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const stop = () => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    let seen: { pid: number; heartbeat: string } | undefined;
    child.on('exit', () => {
      if (seen) resolve(seen);
    });
    const timer = setInterval(() => {
      let watch: { pid: number; heartbeat: string } | undefined;
      try {
        watch = readState(join(cwd, '.agents')).sessions[SESSION]?.watch;
      } catch {
        watch = undefined;
      }
      if (watch?.heartbeat && !seen) {
        seen = { pid: watch.pid, heartbeat: watch.heartbeat };
        clearInterval(timer);
        clearTimeout(giveUp);
        stop();
      }
    }, 50);
    const giveUp = setTimeout(() => {
      clearInterval(timer);
      stop();
      reject(new Error(`no heartbeat\n${stderr}`));
    }, 15_000);
  });
}

describe('a folder with no git repository', () => {
  test('up --file .agents/team.yaml starts a watch that reads that file', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    const file = join(root, '.agents', 'team.yaml');
    mkdirSync(root);
    const text = teamText(root);
    approve(root, file, home, text);
    const flagged = loadTeamFile(root, { file, home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    const found = loadTeamFile(flagged.root, { home });
    expect(found.ok && found.path === flagged.path).toBe(true);
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(true);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', '.agents/team.yaml'], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    const watchdog = made.creates.find((created) => created.label === 'watchdog');
    expect(watchdog?.cwd).toBe(root);
    expect(io.out).toContain('watch: started\n');
    const command = made.runs.find((run) => run.command.includes(' watch'))?.command ?? '';
    expect(command).toContain(' watch');
    expect(command).not.toContain('--file');

    const beat = await runAsPane(command, root, home);
    expect(beat.heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(beat.pid).toBeGreaterThan(0);
  }, 20_000);

  test("a seat's status with no flag reads the file and writes nothing", async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION });
    const code = await runStatus([], io, statusSources(home));
    expect(code).not.toBe(2);
    expect(io.err).not.toContain('not inside a git repository');
    expect(io.out).toContain('team acme');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);
  });

  test('an unapproved file is refused as any unapproved file is', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    const owner = testIo(root, { kind: 'owner' });
    const added = await runAdd(['claude-coordinator-acme'], owner, addSources(home));
    expect(added).toBe(1);
    expect(owner.err).toBe('team add: the file was never approved on this machine: run `team approve`\n');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const seat = testIo(root, { kind: 'seat', name: 'other-seat', pane: 'w9:p1', session: 'elsewhere' });
    const refused = await runAdd(['claude-coordinator-acme'], seat, addSources(home));
    expect(refused).toBe(1);
    expect(seat.err).toContain('only the owner, the coordinator or the operator');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const doctorIo = testIo(root, { kind: 'seat', name: 'other-seat', pane: 'w9:p1' });
    await runDoctor([], doctorIo, doctor(home));
    expect(doctorIo.err).not.toContain('not inside a git repository');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const checkIo = testIo(root, { kind: 'owner' });
    const checked = await check(['HEAD'], checkIo, (cwd, file) => loadConfig(cwd, file, home));
    expect(checked).toBe(2);
    expect(checkIo.err).not.toContain('not inside a git repository: run team from a project, or pass --file');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const watching = testIo(root, { kind: 'owner' });
    const watched = await runWatch([], watching, watchSources(home));
    expect(watched).toBe(0);
    expect(watching.err).not.toContain('not inside a git repository');
    expect(watching.out).toContain('the file was never approved on this machine');
  });
});

describe('a file the watch would not read', () => {
  test('custom/team.yaml in a git project starts no watch', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    approve(root, custom, home, teamText(customDir));
    const flagged = loadTeamFile(root, { file: custom, home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    const found = loadTeamFile(flagged.root, { home });
    expect(found.ok).toBe(false);
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(false);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', custom], io, upSources(home, made));
    expect(code).toBe(1);
    expect(made.creates.some((created) => created.label === 'watchdog')).toBe(false);
    expect(made.runs.some((run) => run.command.includes(' watch'))).toBe(false);
    expect(io.out).toContain(`${WATCH_NOT_STARTED}\n`);
    expect(io.out).not.toContain('watch: started');

    const dry = testIo(root, { kind: 'owner' });
    const preview = await runUp(['--dry-run', '--file', custom], dry, upSources(home, world()));
    expect(preview).toBe(0);
    expect(dry.out).toContain(WATCH_NOT_STARTED);
    expect(dry.out).not.toContain('watchdog');
  });

  test('a second file at the git root is not the one a watch would read', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    approve(root, custom, home, teamText(customDir));
    const flagged = loadTeamFile(root, { file: custom, home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    const found = loadTeamFile(flagged.root, { home });
    if (!found.ok) throw new Error(JSON.stringify(found.errors));
    expect(found.path).not.toBe(flagged.path);
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(false);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', custom], io, upSources(home, made));
    expect(code).toBe(1);
    expect(made.creates.some((created) => created.label === 'watchdog')).toBe(false);
    expect(io.out).toContain(`${WATCH_NOT_STARTED}\n`);
    expect(io.out).not.toContain('watch: started');
  });

  test('the default path starts the watch', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const file = join(root, '.agents', 'team.yaml');
    approve(root, file, home, teamText(root));
    const flagged = loadTeamFile(root, { home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(true);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', file], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    expect(made.creates.some((created) => created.label === 'watchdog')).toBe(true);
    expect(io.out).toContain('watch: started\n');
    expect(io.out).not.toContain(WATCH_NOT_STARTED);
  });
});
