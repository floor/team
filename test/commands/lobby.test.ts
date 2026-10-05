import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runApprove, type ApproveSources } from '../../src/commands/approve.ts';
import { check, loadConfig } from '../../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runStatus, standingSource, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { canonicalLanding } from '../../src/file/paths.ts';
import { rulesText, seatRules, type RulesInput } from '../../src/launch/rules.ts';
import { lobbyDir, verifyLobby } from '../../src/lobby/gate.ts';
import { readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function legacyTeamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
    cwd: .
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    count: 1
`;
}

function migratedTeamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
    cwd: .
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    count: 1
`;
}

function approveYaml(text: string, writeHome: string = home): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(root, { home: writeHome });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, writeHome),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
    writeHome,
  );
}

function world(): {
  launch: Launch;
  workspaces: { label: string; cwd: string }[];
  renames: string[];
  session: 'absent' | 'running';
} {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = {
    launch: {} as Launch,
    workspaces: [] as { label: string; cwd: string }[],
    renames: [] as string[],
    session: 'absent' as 'absent' | 'running',
  };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.workspaces.push({ label, cwd });
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

async function runUpCmd(argv: string[], made: ReturnType<typeof world>, over: Partial<UpSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => [],
    home,
    launch: made.launch,
    now: () => NOW,
    ...over,
  };
  const code = await runUp([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runAddCmd(argv: string[], made: ReturnType<typeof world>, over: Partial<AddSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: runDoctorCmdSources(over.home ? { home: over.home } : {}),
    now: () => NOW,
    launch: made.launch,
    ...over,
  };
  const code = await runAdd([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

function runDoctorCmdSources(over: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...over,
  };
}

async function runDoctorCmd(argv: string[] = [], over: Partial<DoctorSources> = {}) {
  const io = testIo(root, OWNER);
  const sources = runDoctorCmdSources(over);
  const code = await runDoctor([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runStatusCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: StatusSources = {
    live: () => ({
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: root },
        { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby },
      ],
      workspaces: [
        { id: 'w0', label: 'lead' },
        { id: 'w1', label: 'worker' },
      ],
      screens: {},
    }),
    branch: () => 'main',
    standing: standingSource(home),
    now: () => NOW,
    home,
  };
  const code = await runStatus([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runApproveCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: ApproveSources = {
    ask: async () => '5',
    now: () => NOW,
    home,
  };
  const code = await runApprove([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function runCheckCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const code = await check(['main', ...argv, ...FILE], io, (cwd, file) => loadConfig(cwd, file, home));
  return { code, out: io.out, err: io.err };
}

async function runWorktreeCmd(argv: string[] = []) {
  const io = testIo(root, OWNER);
  const sources: WorktreeSources = { home, now: () => NOW };
  const code = await runWorktree([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lobby-test-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = lobbyDir(home);
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'branch', 'fix/fresh');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the lobby gate', () => {
  test('refusal: a symbolic link at the lobby', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const target = join(base, 'target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, lobby, 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: ${lobby} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);

    const runAdd = await runAddCmd(['worker'], world());
    expect(runAdd.code).toBe(1);
    expect(runAdd.err).toContain(`the lobby ${lobby}: ${lobby} is a symbolic link`);
  });

  test('refusal: a symbolic link at its parent (~/.config/team)', async () => {
    approveYaml(migratedTeamYaml());
    rmSync(join(home, '.config', 'team'), { recursive: true, force: true });
    const target = join(base, 'parent-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.config', 'team'), 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: ${join(home, '.config', 'team')} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: a symbolic link at a higher existing ancestor (~/.config)', async () => {
    approveYaml(migratedTeamYaml());
    rmSync(join(home, '.config'), { recursive: true, force: true });
    const target = join(base, 'config-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.config'), 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: ${join(home, '.config')} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: a component owned by another user (simulated through getuid)', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made, { getuid: () => 99999 });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: ${home} is not owned by you`);
    expect(made.workspaces).toHaveLength(0);

    const runAdd = await runAddCmd(['worker'], world(), { getuid: () => 99999 });
    expect(runAdd.code).toBe(1);
    expect(runAdd.err).toContain(`the lobby ${lobby}: ${home} is not owned by you`);
  });

  test('refusal: mode 0755', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o755);

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: has mode 0755, not 0700`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: mode 0750', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o750);

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: has mode 0750, not 0700`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: mode 0600', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o600);

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: has mode 0600, not 0700`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: a regular file where the lobby should be', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(lobby, 'not a folder');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: is not a directory`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: a non-empty lobby (one dotfile)', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    writeFileSync(join(lobby, '.gitkeep'), '');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: is not empty`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: the lobby inside a repository by its logical path', async () => {
    approveYaml(migratedTeamYaml());
    git(home, 'init', '-q');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: is inside the repository ${home}`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('refusal: the lobby inside a repository only by its canonical landing', async () => {
    const repoDir = join(base, 'git-repo');
    git(base, 'init', '-q', repoDir);
    const targetDir = join(repoDir, 'real-parent');
    mkdirSync(targetDir, { recursive: true });

    const linkDir = join(base, 'link-dir');
    symlinkSync(targetDir, linkDir, 'dir');
    const homeInLink = join(linkDir, 'home');
    mkdirSync(homeInLink, { recursive: true });

    approveYaml(migratedTeamYaml(), homeInLink);

    const made = world();
    const run = await runUpCmd([], made, { home: homeInLink });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobbyDir(homeInLink)}: is inside the repository ${repoDir}`);
    expect(made.workspaces).toHaveLength(0);
  });

  test('creation under a umask of 0022 and 0077 ends at 0700', () => {
    const oldUmask = process.umask(0o022);
    try {
      const home1 = join(base, 'umask-22');
      mkdirSync(home1, { recursive: true });
      const res1 = verifyLobby(home1, { create: true });
      expect(res1.ok).toBe(true);
      const mode1 = statSync(lobbyDir(home1)).mode & 0o777;
      expect(mode1).toBe(0o700);

      process.umask(0o077);
      const home2 = join(base, 'umask-77');
      mkdirSync(home2, { recursive: true });
      const res2 = verifyLobby(home2, { create: true });
      expect(res2.ok).toBe(true);
      const mode2 = statSync(lobbyDir(home2)).mode & 0o777;
      expect(mode2).toBe(0o700);
    } finally {
      process.umask(oldUmask);
    }
  });

  test('a link planted between creation of two components is refused', () => {
    const homePlant = join(base, 'home-plant');
    mkdirSync(homePlant, { recursive: true });
    mkdirSync(join(homePlant, '.config'), { recursive: true });
    const target = join(base, 'planted-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(homePlant, '.config', 'team'), 'dir');

    const res = verifyLobby(homePlant, { create: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.problem).toBe('symlink');
      expect(res.text).toContain(`${join(homePlant, '.config', 'team')} is a symbolic link`);
    }
  });

  test('doctor reports lobby status without creating anything', async () => {
    approveYaml(migratedTeamYaml());
    expect(existsSync(lobby)).toBe(false);

    const doc = await runDoctorCmd();
    expect(doc.code).toBe(0);
    expect(doc.out).toContain(`the lobby ${lobby}: will be created at the first launch\n`);
    expect(existsSync(lobby)).toBe(false);

    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const docVerified = await runDoctorCmd();
    expect(docVerified.code).toBe(0);
    expect(docVerified.out).toContain(`the lobby ${lobby}: verified\n`);
  });
});

describe('trust: validation', () => {
  test('non-empty sequence of absolute paths accepted, ~ expanded as first segment', () => {
    const yaml = migratedTeamYaml();
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
  });

  test('empty trust is refused', () => {
    const yaml = migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, 'trust: []\n');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('must not be empty') || e.message.includes('cannot be empty'))).toBe(true);
    }
  });

  test('relative paths or globs in migrated trust are refused', () => {
    const yamlWithGlob = migratedTeamYaml().replace(root, `${root}/*`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yamlWithGlob);
    const loadedGlob = loadTeamFile(root, { home });
    expect(loadedGlob.ok).toBe(false);
    if (!loadedGlob.ok) {
      expect(loadedGlob.errors.some((e) => e.message.includes('glob'))).toBe(true);
    }

    const yamlWithDotDot = migratedTeamYaml().replace(root, `${root}/../acme`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yamlWithDotDot);
    const loadedDotDot = loadTeamFile(root, { home });
    expect(loadedDotDot.ok).toBe(false);
    if (!loadedDotDot.ok) {
      expect(loadedDotDot.errors.some((e) => e.message.includes('"." or ".."'))).toBe(true);
    }
  });

  test('an existing entry that is not a directory is refused', () => {
    const fileEntry = join(root, 'README.md');
    const yaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ${fileEntry}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('is not a directory'))).toBe(true);
    }
  });

  test('two spellings of one folder compare equal by canonical landing', () => {
    const target = join(base, 'real-folder');
    mkdirSync(target, { recursive: true });
    const sym = join(base, 'sym-folder');
    symlinkSync(target, sym, 'dir');

    const land1 = canonicalLanding(target).landing;
    const land2 = canonicalLanding(sym).landing;
    expect(land1).toBe(land2);
  });

  test('mixed file (legacy patterns and absolute entries) exits 2 in all 7 commands', async () => {
    const mixedYaml = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
  - ~/.config/team/lobby
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
    writeFileSync(join(root, '.agents', 'team.yaml'), mixedYaml);

    expect((await runStatusCmd()).code).toBe(2);
    expect((await runDoctorCmd()).code).toBe(2);
    expect((await runUpCmd([], world())).code).toBe(2);
    expect((await runAddCmd(['lead'], world())).code).toBe(2);
    expect((await runApproveCmd()).code).toBe(2);
    expect((await runCheckCmd()).code).toBe(2);
    expect((await runWorktreeCmd(['new', 'task-1', '--kind', 'feat'])).code).toBe(2);
  });
});

describe('legacy files and migration', () => {
  test('read-only commands (status, doctor, check, worktree) work on a legacy file', async () => {
    approveYaml(legacyTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready' },
          worker: { stage: 'ready' },
        },
        worktrees: {},
        watch: { pid: process.pid, heartbeat: NOW.toISOString() },
      };
    });

    expect((await runStatusCmd()).code).not.toBe(2);
    expect((await runDoctorCmd()).code).not.toBe(2);
    expect((await runCheckCmd()).code).not.toBe(2);
    expect((await runWorktreeCmd(['new', 'task-1', '--kind', 'feat'])).code).toBe(0);
  });

  test('up and add refuse every seat with the migration message naming the lobby path and showing trust:', async () => {
    approveYaml(legacyTeamYaml());

    const madeUp = world();
    const upRes = await runUpCmd([], madeUp);
    expect(upRes.code).toBe(1);
    expect(upRes.err).toContain(`team up: the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n`);
    expect(madeUp.workspaces).toHaveLength(0);

    const madeAdd = world();
    const addRes = await runAddCmd(['worker'], madeAdd);
    expect(addRes.code).toBe(1);
    expect(addRes.err).toContain(`team add: the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n`);
    expect(madeAdd.workspaces).toHaveLength(0);
  });

  test('doctor prints migration note once for legacy file, and stops after migration plus approval', async () => {
    approveYaml(legacyTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });

    const docBefore = await runDoctorCmd();
    expect(docBefore.code).toBe(0);
    expect(docBefore.out).toContain(`--    the file is legacy: migrate from ../worktrees/acme/.lobby to ${lobby} by writing trust:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n`);

    approveYaml(migratedTeamYaml());
    const docAfter = await runDoctorCmd();
    expect(docAfter.code).toBe(0);
    expect(docAfter.out).not.toContain('the file is legacy');
  });

  test('a migrated but unapproved file refuses up and add', async () => {
    approveYaml(legacyTeamYaml());
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());

    const upRes = await runUpCmd([], world());
    expect(upRes.code).toBe(1);
    expect(upRes.err).toContain('the file is not the approved one');

    const addRes = await runAddCmd(['worker'], world());
    expect(addRes.code).toBe(1);
    expect(addRes.err).toContain('the file is not the approved one');
  });
});

describe('start_cwd and removal check', () => {
  test('start_cwd is recorded on launch and exposed in status --json', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const upRes = await runUpCmd([], made);
    expect(upRes.code).toBe(0);

    const state = readState(dir);
    expect(state.sessions['acme']?.seats['worker']?.start_cwd).toBe(canonicalLanding(lobby).landing);

    const statusRes = await runStatusCmd(['--json']);
    expect(statusRes.code).not.toBe(2);
    const parsed = JSON.parse(statusRes.out);
    const workerRow = parsed.rows.find((r: { name: string }) => r.name === 'worker');
    expect(workerRow).toBeDefined();
    expect(workerRow.start_cwd).toBe(canonicalLanding(lobby).landing);
  });

  test('removal check in doctor: 3 states and ignoring stopped historical seats', async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const oldLanding = canonicalLanding(oldLobby).landing;

    // State 1: A live seat started in the old lobby
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1', start_cwd: oldLanding },
        },
        worktrees: {},
      };
    });
    const docState1 = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: oldLanding }],
    });
    expect(docState1.out).toContain(`warn  the old lobby ../worktrees/acme/.lobby: seat worker started in it; stop it before removing the folder\n`);

    // State 2: A live seat without start_cwd
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1' },
        },
        worktrees: {},
      };
    });
    const docState2 = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: oldLanding }],
    });
    expect(docState2.out).toContain(`warn  the old lobby ../worktrees/acme/.lobby: seat worker has no recorded start_cwd; stop it before removing the folder\n`);

    // State 3: Live seat with start_cwd in new lobby (may be removed)
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1', start_cwd: canonicalLanding(lobby).landing },
        },
        worktrees: {},
      };
    });
    const docState3 = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby }],
    });
    expect(docState3.out).toContain(`ok    the old lobby ../worktrees/acme/.lobby: may be removed\n`);

    // Correction check: A stopped historical seat (no pane, not running, no waiting) without start_cwd does NOT block removal
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          historical: { stage: 'ready', pane: 'w99:p1' }, // historical, no agent in agentList
          worker: { stage: 'ready', pane: 'w1:p1', start_cwd: canonicalLanding(lobby).landing },
        },
        worktrees: {},
      };
    });
    const docHistorical = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby }],
    });
    expect(docHistorical.out).toContain(`ok    the old lobby ../worktrees/acme/.lobby: may be removed\n`);
  });
});

describe('rules text', () => {
  test('assert exact rules text for shared and worktree seats, byte-identical otherwise', () => {
    const baseInput: RulesInput = {
      coordinator: 'lead',
      rules: ['Never break CI.'],
      signature: { commit: 'Agent: Claude Opus 5.5 · implementer', pullRequest: '**Agent:** Claude Opus 5.5 · implementer', commitPosition: 'trailer' },
      workspace: { mode: 'worktree', protected: ['.'], branch: '{kind}/{task}', cwd: root },
    };

    const worktreeRules = seatRules(baseInput);
    const sharedRules = seatRules({
      ...baseInput,
      workspace: { mode: 'shared', protected: ['.'], cwd: root },
    });

    // Check specific workspace rules
    expect(worktreeRules).toContain('Work on the code in the worktree your brief names, never in the checkout you started in. Branches are named {kind}/{task}.');
    expect(sharedRules).toContain(`Change to ${root} before any project work.`);

    // Check that every other rule is byte-identical
    const worktreeFiltered = worktreeRules.filter((r) => !r.startsWith('Work on the code in the worktree'));
    const sharedFiltered = sharedRules.filter((r) => !r.startsWith('Change to '));
    expect(worktreeFiltered).toEqual(sharedFiltered);

    // Full exact output assertion for shared seat
    expect(sharedRules).toEqual([
      'End every commit message and every pull request body with your signature, given below.',
      'Never stop at a question: tell the coordinator (lead) in one line and keep working.',
      'Never run `team trust` or `team approve`, and never edit `trust:` in the team file.',
      'In a protected checkout, never switch the branch, reset or commit.',
      'Never break CI.',
      'Your signature in a commit message, as a trailer, in a last paragraph of its own that holds trailers only: Agent: Claude Opus 5.5 · implementer',
      'Your signature in a pull request body, as its last line: **Agent:** Claude Opus 5.5 · implementer',
      'Protected checkouts, relative to the project root: .',
      `Change to ${root} before any project work.`,
    ]);
  });
});
