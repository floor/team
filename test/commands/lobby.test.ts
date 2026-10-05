import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { validateTeamFile } from '../../src/file/validate.ts';
import { absoluteTrustProblem, canonicalLanding, insideTrust } from '../../src/file/paths.ts';
import { rulesText, seatRules, type RulesInput } from '../../src/launch/rules.ts';
import { defaultFs, findRepoRoot, lobbyDir, verifyLobby, type FsReader } from '../../src/lobby/gate.ts';
import { seatStart } from '../../src/worktree/place.ts';
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
  /** Every command typed into a pane (`pane run`), in order. */
  runs: string[];
  /** Every text typed into a pane (`typeText`), in order. */
  typed: string[];
  /** Every workspace a close was asked for, in order. */
  closed: string[];
  /** Every pane the world holds, with an agent in it or not. */
  paneIds(): string[];
} {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = {
    launch: {} as Launch,
    workspaces: [] as { label: string; cwd: string }[],
    renames: [] as string[],
    session: 'absent' as 'absent' | 'running',
    runs: [] as string[],
    typed: [] as string[],
    closed: [] as string[],
    paneIds: () => [...panes.keys()],
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
    paneRun(_session, pane, command) {
      made.runs.push(command);
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    typeText(_session, _pane, text) {
      made.typed.push(text);
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      made.closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
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
    doctor: runDoctorCmdSources(),
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
    expect(run.code).toBe(2);
    expect(run.err).toContain('symbolic link');
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${lobby} is a symbolic link`);

    const runAdd = await runAddCmd(['worker'], world());
    expect(runAdd.code).toBe(2);
    expect(runAdd.err).toContain('symbolic link');
  });

  test('refusal: a symbolic link at its parent (~/.config/team)', async () => {
    approveYaml(migratedTeamYaml());
    rmSync(join(home, '.config', 'team'), { recursive: true, force: true });
    const target = join(base, 'parent-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.config', 'team'), 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(2);
    expect(run.err).toContain(`${join(home, '.config', 'team')} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${join(home, '.config', 'team')} is a symbolic link`);
  });

  test('refusal: a symbolic link at a higher existing ancestor (~/.config)', async () => {
    approveYaml(migratedTeamYaml());
    rmSync(join(home, '.config'), { recursive: true, force: true });
    const target = join(base, 'config-target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(home, '.config'), 'dir');

    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(2);
    expect(run.err).toContain(`${join(home, '.config')} is a symbolic link`);
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${join(home, '.config')} is a symbolic link`);
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
    expect(run.code).toBe(2);
    expect(run.err).toContain('is not a directory');
    expect(made.workspaces).toHaveLength(0);
    const gate = verifyLobby(home);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain('is not a directory');
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

    const gate = verifyLobby(homeInLink, { create: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`is inside the repository ${repoDir}`);
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

  test('refusal: mode 01700 (sticky) and 02700 (setgid) refused as not 0700', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o1700);
    const run1 = await runUpCmd([], world());
    expect(run1.code).toBe(1);
    expect(run1.err).toContain(`the lobby ${lobby}: has mode 01700, not 0700`);

    const setgidFs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const s = defaultFs.lstat(p);
        if (p === lobby) {
          const m = Object.create(s);
          m.mode = (s.mode & ~0o7777) | 0o2700;
          return m;
        }
        return s;
      },
    };
    const run2 = await runUpCmd([], world(), { fs: setgidFs });
    expect(run2.code).toBe(1);
    expect(run2.err).toContain(`the lobby ${lobby}: has mode 02700, not 0700`);
  });

  test('refusal: link swapped between parent lstat and mkdirSync using injected FsReader', async () => {
    approveYaml(migratedTeamYaml());
    const swappingFs: FsReader = {
      ...defaultFs,
      mkdir(p, opts) {
        if (p.endsWith('lobby')) {
          const escaped = join(base, 'escaped-lobby-target');
          mkdirSync(escaped, { recursive: true });
          rmSync(join(home, '.config'), { recursive: true, force: true });
          symlinkSync(escaped, join(home, '.config'), 'dir');
        }
        defaultFs.mkdir(p, opts);
      },
    };
    const res = verifyLobby(home, { create: true, fs: swappingFs });
    expect(res.ok).toBe(false);
  });

  test('refusal: dangling link at lobby refused safely in both create: true and create: false', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    symlinkSync(join(base, 'non-existent-target'), lobby);

    const resCreate = verifyLobby(home, { create: true });
    expect(resCreate.ok).toBe(false);
    if (!resCreate.ok) expect(resCreate.problem).toBe('symlink');

    const resNoCreate = verifyLobby(home, { create: false });
    expect(resNoCreate.ok).toBe(false);
    if (!resNoCreate.ok) expect(resNoCreate.problem).toBe('symlink');

    const doc = await runDoctorCmd();
    expect(doc.out).not.toContain('will be created at the first launch');
    expect(doc.err).toContain('symbolic link');
  });

  test('refusal: readdir error on lobby refuses and does not succeed open', () => {
    const brokenFs: FsReader = {
      ...defaultFs,
      readdir() {
        const err: any = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      },
    };
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const res = verifyLobby(home, { create: false, fs: brokenFs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain('cannot read directory: EACCES');
  });

  test('up gate runs after caller and approval refusals (unapproved file does not create lobby)', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain('the file was never approved on this machine');
    expect(existsSync(lobby)).toBe(false);
  });

  test('refusal: component owned by foreign user via injected FsReader', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const myUid = process.getuid ? process.getuid() : 1000;
    const foreignFs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const realStat = defaultFs.lstat(p);
        if (p === lobby) {
          const m = Object.create(realStat);
          m.uid = myUid + 1;
          return m;
        }
        return realStat;
      },
    };
    const res = verifyLobby(home, { create: false, fs: foreignFs, getuid: () => myUid });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain(`${lobby} is not owned by you`);
  });

  test('refusal: non-empty lobby with subfolder', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(join(lobby, 'subfolder'), { recursive: true });
    chmodSync(lobby, 0o700);
    const run = await runUpCmd([], world());
    expect(run.code).toBe(1);
    expect(run.err).toContain(`the lobby ${lobby}: is not empty`);
  });

  test('findRepoRoot accepts .git as a file (worktree / submodule style)', () => {
    const fakeRepo = join(base, 'fake-wt-repo');
    mkdirSync(fakeRepo, { recursive: true });
    writeFileSync(join(fakeRepo, '.git'), 'gitdir: /somewhere/else\n');
    const sub = join(fakeRepo, 'sub', 'folder');
    mkdirSync(sub, { recursive: true });
    expect(findRepoRoot(sub)).toBe(fakeRepo);
  });

  test('refusal: symbolic link at home itself', async () => {
    const realHome = join(base, 'real-home');
    mkdirSync(realHome, { recursive: true });
    const symHome = join(base, 'sym-home');
    symlinkSync(realHome, symHome, 'dir');

    const gate = verifyLobby(symHome);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.text).toContain(`${symHome} is a symbolic link`);
  });

  test('dry run shows every seat in the machine lobby', async () => {
    approveYaml(migratedTeamYaml());
    const dry = await runUpCmd(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`workspace create --cwd ${lobby} --label lead`);
    expect(dry.out).toContain(`workspace create --cwd ${lobby} --label worker`);
    expect(dry.out).not.toContain('mkdir -p');
  });

  test('real run makes the machine lobby and leaves the old lobby untouched', async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(0);
    expect(existsSync(lobby)).toBe(true);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: lobby });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: lobby });
    expect(readdirSync(oldLobby)).toEqual([]);
  });
});

describe('trust: validation', () => {
  test('non-empty sequence of absolute paths accepted, ~ expanded as first segment', () => {
    const yaml = migratedTeamYaml();
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
  });

  test('empty trust loads and cannot launch', async () => {
    const yaml = migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, 'trust: []\n');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain('the file is legacy: migrate trust to absolute paths');
    expect(made.workspaces).toEqual([]);
    expect(existsSync(lobby)).toBe(false);
    const status = await runStatusCmd();
    expect(status.code).not.toBe(2);
    const work = await runWorktreeCmd(['new', 'task']);
    expect(work.code).not.toBe(2);
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

  test('two legal spellings of one folder compare equal and case stays different', () => {
    const slash = canonicalLanding(`${root}/`);
    const plain = canonicalLanding(root);
    expect(slash.error).toBeUndefined();
    expect(slash.landing).toBe(plain.landing);
    const lower = canonicalLanding(join(root, 'src'));
    const upper = canonicalLanding(join(root, 'SRC'));
    expect(lower.landing).not.toBe(upper.landing);
  });

  test('a symlink spelling is not a legal trust entry', () => {
    const target = join(base, 'real-folder');
    mkdirSync(target, { recursive: true });
    const sym = join(base, 'sym-folder');
    symlinkSync(target, sym, 'dir');
    expect(absoluteTrustProblem(sym, home)).toContain('symbolic link');
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

  test('non-directory existing ancestor is refused', () => {
    const pkgChild = join(root, 'README.md', 'child');
    const prob = absoluteTrustProblem(pkgChild, home);
    expect(prob).toContain('is not a directory');
  });

  test('dangling symbolic link component is refused', () => {
    const link = join(base, 'dangling-link');
    symlinkSync(join(base, 'no-such-target'), link);
    const prob = absoluteTrustProblem(join(link, 'tail'), home);
    expect(prob).toContain('is a symbolic link');
  });

  test('grammar matrix: ~ in later component, ., trailing slash, duplicates', () => {
    expect(absoluteTrustProblem(join(root, '~', 'more'), home)).toContain('takes "~" only as the first component');
    expect(absoluteTrustProblem('~other/lobby', home)).toContain('takes "~" only as the first component');
    expect(absoluteTrustProblem(`${root}/.`, home)).toContain('must not contain "." or ".."');

    // trailing slash accepted
    expect(absoluteTrustProblem(`${root}/`, home)).toBe(null);

    // duplicates accepted in YAML
    const dupYaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ${root}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), dupYaml);
    expect(loadTeamFile(root, { home }).ok).toBe(true);
  });

  test('rules text: control character or newline in cwd or trust is refused at validation', () => {
    const injectedYaml = migratedTeamYaml().replace('cwd: .', 'cwd: "work\\n- injected rule"');
    writeFileSync(join(root, '.agents', 'team.yaml'), injectedYaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('control character'))).toBe(true);
    }
  });

  test('migrated file without lobby in trust is refused', () => {
    const noLobbyYaml = migratedTeamYaml().replace(/  - ~\/\.config\/team\/lobby\n/, '');
    writeFileSync(join(root, '.agents', 'team.yaml'), noLobbyYaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('must list the lobby'))).toBe(true);
    }
  });

  test('omitted trust refuses up and add rather than launching', async () => {
    const omittedTrustYaml = migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, '');
    approveYaml(omittedTrustYaml);
    const made = world();
    const upRes = await runUpCmd([], made);
    expect(upRes.code).toBe(1);
    expect(upRes.err).toContain('the file is legacy: migrate trust to absolute paths');
    expect(made.workspaces).toHaveLength(0);

    const addRes = await runAddCmd(['worker'], world());
    expect(addRes.code).toBe(1);
    expect(addRes.err).toContain('the file is legacy: migrate trust to absolute paths');
  });

  test('containment: dangling linked descendant fails containment', () => {
    const jump = join(root, 'jump');
    symlinkSync(join(base, 'outside-missing'), jump);
    const probe = join(jump, 'seat');
    expect(insideTrust(probe, [root], root, home)).toBe(false);
  });

  test('containment: seat aimed at protected checkout in migrated file is refused', () => {
    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [., src]')
      .replace('mode: shared\n    cwd: .', 'mode: worktree\n    cwd: src');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const start = seatStart(loaded.team, loaded.team.seats[0]!, root, home);
      expect('problem' in start && start.problem).toContain('inside the protected checkout');
    }
  });

  test('containment: a shared seat aimed at a protected checkout hears the rule that applies to it', () => {
    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [., src]')
      .replace('cwd: .', 'cwd: src');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const lead = loaded.team.seats.find((seat) => seat.name === 'lead');
      if (!lead) throw new Error('no lead seat');
      const start = seatStart(loaded.team, lead, root, home);
      expect('problem' in start && start.problem).toContain('a shared seat never works in a protected checkout');
    }
  });

  test('containment: worktrees never land in a protected checkout', () => {
    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [src]')
      .replace('path: ../worktrees/{repo}/{task}', 'path: src/acme/{task}');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    // The full load refuses the file with its own sentence...
    const full = loadTeamFile(root, { home });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.errors.map((e) => e.message).join('\n')).toContain('puts worktrees inside the protected checkout src');
    // ...and a validation-only load, which skips the placement checks, still meets the seat guard.
    const checked = loadTeamFile(root, { home, checkOnly: true });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      const lead = checked.team.seats.find((seat) => seat.name === 'lead');
      if (!lead) throw new Error('no lead seat');
      const start = seatStart(checked.team, lead, root, home);
      expect('problem' in start && start.problem).toContain('worktrees never land in a protected checkout');
      if ('problem' in start) expect(start.problem).toContain('inside the protected checkout src');
    }
  });

  test('containment: worktrees folder symlinked into project in migrated file is refused', () => {
    const liveDir = join(root, 'live');
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(join(base, 'worktrees'), { recursive: true });
    symlinkSync(liveDir, join(base, 'worktrees', 'acme'), 'dir');

    const yaml = migratedTeamYaml()
      .replace('protected: [.]', 'protected: [., live]');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errors.some((e) => e.message.includes('inside the protected checkout'))).toBe(true);
    }
  });
});

// A volume either folds two spellings of one name into one folder or keeps them apart. The probe
// uses raw syscalls on folders this test made; each expectation below is the answer for the volume
// the suite runs on, so every test states a definite verdict and none of them is skipped.
function foldsSpellings(variant: string, real: string): boolean {
  try {
    lstatSync(variant);
  } catch {
    return false;
  }
  try {
    return realpathSync(variant) === realpathSync(real);
  } catch {
    return false;
  }
}

describe('a refused folder is refused under every spelling that names it', () => {
  const only = (entry: string) => migratedTeamYaml().replace(/trust:\n(?:  - .*\n)+/, `trust:\n  - ${entry}\n`);
  // The same file with the entry added to a trust list that covers the lobby, the root and the
  // worktrees, so a load failure names the entry, never the coverage a single-entry file lacks.
  const plus = (entry: string) => migratedTeamYaml().replace('trust:\n', `trust:\n  - ${entry}\n`);

  const verdicts = (entry: string, homeDir = home, rootDir = root): string[] => {
    const result = validateTeamFile(only(entry), { home: homeDir, root: rootDir });
    return result.ok ? [] : result.errors.map((problem) => problem.message);
  };

  test('a second spelling of the home is refused where it names the home', () => {
    const variant = join(base, 'HOME');
    const folds = foldsSpellings(variant, home);
    const found = verdicts(variant);
    if (folds) {
      expect(found.join('\n')).toContain('is the home itself');
    } else {
      expect(found).toEqual([]);
    }
    writeFileSync(join(root, '.agents', 'team.yaml'), plus(variant));
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(!folds);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.message).join('\n')).toContain('is the home itself');
  });

  test("a second spelling of the project's parent is refused where it names the parent", () => {
    const project = join(base, 'PB', 'proj');
    mkdirSync(project, { recursive: true });
    const variant = join(base, 'pb');
    const folds = foldsSpellings(variant, join(base, 'PB'));
    const found = verdicts(variant, home, project);
    if (folds) {
      expect(found.join('\n')).toContain('is a parent of the project');
    } else {
      expect(found).toEqual([]);
    }
  });

  test("a second spelling of the parent that holds the project is refused at load", () => {
    const project = join(base, 'PB', 'proj');
    const agents = join(project, '.agents');
    mkdirSync(agents, { recursive: true });
    const variant = join(base, 'pb');
    const folds = foldsSpellings(variant, join(base, 'PB'));
    // The project moved, so its worktrees folder moved with it: the fixture's worktrees entry has
    // to move too, or the load refuses `workspace.path ... outside trust` for a reason that is not
    // the entry under test — on a volume that keeps "pb" apart from "PB" the variant entry used to
    // cover that path only by folding, which is exactly the volume this case is not about.
    const text = migratedTeamYaml()
      .replaceAll(root, project)
      .replace(join(base, 'worktrees'), join(base, 'PB', 'worktrees'))
      .replace('trust:\n', `trust:\n  - ${variant}\n`);
    writeFileSync(join(agents, 'team.yaml'), text);
    const loaded = loadTeamFile(project, { file: join(agents, 'team.yaml'), home });
    expect(loaded.ok).toBe(!folds);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.message).join('\n')).toContain('is a parent of the project');
  });

  test('a second spelling of the folders that hold the lobby and the approval store is refused', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const folds = foldsSpellings(join(base, 'HOME'), home);
    const found = [
      join(base, 'HOME', '.config'),
      join(base, 'HOME', '.config', 'team'),
    ].flatMap((entry) => verdicts(entry));
    if (folds) {
      expect(found).toHaveLength(2);
      for (const message of found) expect(message).toContain('would cover');
    } else {
      expect(found).toEqual([]);
    }
  });

  test('another normalisation form of the home is refused where it names the home', () => {
    const homeUni = join(base, 'Hómé');
    mkdirSync(homeUni);
    const variant = join(base, 'Hómé');
    const folds = foldsSpellings(variant, homeUni);
    const found = verdicts(variant, homeUni);
    if (folds) {
      expect(found.join('\n')).toContain('is the home itself');
    } else {
      expect(found).toEqual([]);
    }
  });

  test('an entry that does not exist yet resolves as far as it exists and keeps the rest as written', () => {
    const variant = join(base, 'HOME');
    const folds = foldsSpellings(variant, home);
    const under = join(variant, 'seat');
    expect(canonicalLanding(under).landing).toBe(folds ? join(realpathSync(home), 'seat') : under);
    expect(verdicts(under)).toEqual([]);
    writeFileSync(join(root, '.agents', 'team.yaml'), plus(under));
    expect(loadTeamFile(root, { home }).ok).toBe(true);
  });

  test("the spellings that name a refused folder exactly still refuse, and the team's own folders still accept", () => {
    expect(verdicts('/').join('\n')).toContain('is the root of the filesystem');
    expect(verdicts(home).join('\n')).toContain('is the home itself');
    expect(verdicts(join(home, '.config', 'team')).join('\n')).toContain('would cover');
    expect(verdicts(root, home, root)).toEqual([]);
    expect(verdicts(join(root, 'work'), home, root)).toEqual([]);
    expect(verdicts(lobbyDir(home))).toEqual([]);
    expect(verdicts(join(base, 'worktrees'))).toEqual([]);
    expect(verdicts(join(base, 'elsewhere'))).toEqual([]);
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

  test('a legacy file whose worktrees sit inside the project loads and reads; the seat is refused at placement', async () => {
    // Main loaded such a file and refused the seat at launch; the load-time containment of
    // workspace.path holds migrated files only, so this file must still load and read.
    const yaml = legacyTeamYaml().replace('../worktrees/{repo}/{task}', 'wt/{task}');
    approveYaml(yaml);

    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    expect((await runStatusCmd()).code).not.toBe(2);
    expect((await runDoctorCmd()).code).not.toBe(2);

    if (!loaded.ok) return;
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('no worker seat');
    const start = seatStart(loaded.team, worker, root, home);
    expect('problem' in start && start.problem).toContain('inside the protected checkout');
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

    // Migrated but unapproved: migration note still prints
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const docUnapproved = await runDoctorCmd();
    expect(docUnapproved.out).toContain('the file is legacy: migrate');

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

  test('temporary add waits in machine lobby', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    await runUpCmd([], made);
    const before = made.workspaces.length;
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made);
    expect(addRun.code).toBe(0);
    const added = made.workspaces.slice(before);
    expect(added).toContainEqual({ label: 'worker-tmp-1', cwd: lobby });
  });

  test('add refuses when trust has no lobby and leaves file untouched', async () => {
    const noLobbyYaml = migratedTeamYaml().replace(/  - ~\/\.config\/team\/lobby\n/, '');
    writeFileSync(join(root, '.agents', 'team.yaml'), noLobbyYaml);
    const before = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    const made = world();
    const addRun = await runAddCmd(['worker'], made);
    expect(addRun.code).not.toBe(0);
    expect(made.workspaces).toEqual([]);
    const after = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    expect(after).toBe(before);
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

  test('resumed launch of pre-migration seat does not record or infer start_cwd', async () => {
    approveYaml(migratedTeamYaml());
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          worker: { stage: 'ready', pane: 'w1:p1' },
        },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const upRes = await runUpCmd([], made, {
      sessionRunning: () => true,
      agents: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: root }],
    });
    expect(upRes.code).toBe(0);
    const state = readState(dir);
    expect(state.sessions['acme']?.seats['worker']?.start_cwd).toBeUndefined();
  });

  test('doctor removal check fails closed when liveList is null', async () => {
    approveYaml(migratedTeamYaml());
    const oldLobby = join(base, 'worktrees', 'acme', '.lobby');
    mkdirSync(oldLobby, { recursive: true });
    const doc = await runDoctorCmd([], {
      sessionRunning: () => true,
      agentList: () => null,
    });
    expect(doc.out).toContain("can't tell if live seats are using it: herdr doesn't answer");
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

describe('a launch line that cannot run where the seat starts', () => {
  function workerLaunch(): string {
    return migratedTeamYaml().replace(
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: zsh ../tools/x.sh\n',
    );
  }

  test('the dry run leaves the seat out before its workspace is made, and the others go on', async () => {
    approveYaml(workerLaunch());
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const run = await runUpCmd(['--dry-run'], world());
    expect(run.code).toBe(0);
    expect(run.out).toContain('worker: would refuse: its launch line runs `../tools/x.sh`');
    expect(run.out).toContain(lobby);
    expect(run.out).not.toContain('--label worker ');
    expect(run.out).not.toContain('mkdir -p');
    expect(run.out).toContain(`--cwd ${lobby} --label lead`);
  });

  test('the real run refuses that seat only: its workspace is never made, the others start', async () => {
    approveYaml(workerLaunch());
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const made = world();
    const run = await runUpCmd([], made);
    expect(run.code).toBe(1);
    expect(run.out).toContain('worker: left out: refused: its launch line runs `../tools/x.sh`');
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: lobby });
    expect(made.workspaces.some((workspace) => workspace.label === 'worker')).toBe(false);
  });

  test('add refuses the seat too, before the file is edited, and makes no workspace', async () => {
    const text = workerLaunch();
    approveYaml(text);
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const made = world();
    const run = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain('its launch line runs `../tools/x.sh`');
    expect(made.workspaces).toEqual([]);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(text);
  });
});

describe('the gate fails closed and the launch uses the path it verified', () => {
  test('a missing config directory is absent, not a failure', () => {
    const res = verifyLobby(home, { create: false });
    expect(res).toEqual({ ok: true, missing: true });
  });

  test('a read error on .git refuses and names the path and the code', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        if (p === join(lobby, '.git')) {
          const err = Object.assign(new Error('denied'), { code: 'EACCES' });
          throw err;
        }
        return defaultFs.lstat(p);
      },
    };
    const res = verifyLobby(home, { create: false, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.text).toContain(join(lobby, '.git'));
      expect(res.text).toContain('EACCES');
    }
  });

  test('resolving the home is a refusal when it cannot be read', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    const fs: FsReader = {
      ...defaultFs,
      realpath(p) {
        if (p === home) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return defaultFs.realpath(p);
      },
    };
    const res = verifyLobby(home, { create: false, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.text).toContain(home);
      expect(res.text).toContain('EACCES');
    }
  });

  test('a link swapped at the last moment the gate allows is refused and leaves the folder it names unchanged', () => {
    const outside = join(base, 'outside-mode');
    mkdirSync(outside, { recursive: true });
    chmodSync(outside, 0o755);
    let seen = 0;
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const stat = defaultFs.lstat(p);
        // The swap lands after the read that returns a directory and before whatever the gate
        // does next with the path — the last moment the gate allows.
        if (p === lobby && stat.isDirectory() && ++seen === 2) {
          rmSync(lobby, { recursive: true });
          symlinkSync(outside, lobby, 'dir');
        }
        return stat;
      },
    };
    const res = verifyLobby(home, { create: true, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toBe('symlink');
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  test('a link swapped after the lobby is created is caught by the second pass', () => {
    let directories = 0;
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        const stat = defaultFs.lstat(p);
        if (p === lobby && stat.isDirectory()) {
          directories++;
          if (directories >= 2) {
            return { isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false, mode: stat.mode, uid: stat.uid, dev: stat.dev, ino: stat.ino };
          }
        }
        return stat;
      },
    };
    const res = verifyLobby(home, { create: true, fs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain('symbolic link');
  });

  /** An FsReader that swaps the lobby out of the way just before the `n`th read of its canonical
   *  path — after the gate's read, against the check that comes next: `'folder'` puts a fresh
   *  empty folder of the same owner and mode where the lobby was, a path puts a link there.
   *  A replacement folder is made beside the lobby while the lobby still exists and renamed into
   *  place: `rmSync` followed by `mkdirSync` can hand the old inode straight back — Linux did in
   *  CI — and a folder with the gate's own device and inode reads as the same folder, rightly. */
  function swapLobbyAt(n: number, replacement: 'folder' | string): FsReader {
    let seen = 0;
    return {
      ...defaultFs,
      realpath(p) {
        if (p === lobby && ++seen === n) {
          if (replacement === 'folder') {
            const aside = `${lobby}.replacement`;
            mkdirSync(aside, { mode: 0o700 });
            rmSync(lobby, { recursive: true });
            renameSync(aside, lobby);
          } else {
            rmSync(lobby, { recursive: true });
            symlinkSync(replacement, lobby, 'dir');
          }
        }
        return defaultFs.realpath(p);
      },
    };
  }

  test('a lobby swapped after the gate creates no workspace, no pane and no typed input', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    // The replacement is a real folder of the same owner, mode and emptiness: no link, no mode
    // difference, the same canonical path. Only device and inode tell it from the gate's folder.
    const run = await runUpCmd([], made, { fs: swapLobbyAt(2, 'folder') });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([]);
    expect(made.paneIds()).toEqual([]);
    expect(made.runs).toEqual([]);
    expect(made.typed).toEqual([]);
    expect(run.out).toContain(`lead: left out: the lobby ${lobby}: it is not the folder the gate read`);
    expect(Object.keys(readState(dir).sessions['acme']?.seats ?? {})).toEqual([]);
  });

  test('add creates nothing for the same swap, and leaves the folder it names unchanged', async () => {
    approveYaml(migratedTeamYaml());
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    chmodSync(outside, 0o755);
    const made = world();
    const run = await runAddCmd(['worker'], made, { fs: swapLobbyAt(2, outside) });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([]);
    expect(made.paneIds()).toEqual([]);
    expect(made.runs).toEqual([]);
    expect(made.typed).toEqual([]);
    expect(run.out).toContain(`worker: left out: the lobby ${lobby}: canonical path`);
    expect(readdirSync(outside)).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  test('a swap between two seats stops the next one and leaves the first running', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    // The gate reads first, the lead's confirmation second (the swap is not there yet), the
    // worker's confirmation third — after the lead was created, before the worker is.
    const run = await runUpCmd([], made, { fs: swapLobbyAt(3, 'folder') });
    expect(run.code).toBe(1);
    expect(made.workspaces).toEqual([{ label: 'lead', cwd: lobby }]);
    expect(run.out).toContain('lead: ready');
    expect(run.out).toContain(`worker: left out: the lobby ${lobby}: it is not the folder the gate read`);
    // The first seat was created while the path was the verified lobby; nothing closes it.
    expect(made.closed).toEqual([]);
    expect(made.launch.agentPanes('acme')).toEqual(['w1:p1']);
  });

  test('a read error while resolving a landing is a refusal', () => {
    const fs: FsReader = {
      ...defaultFs,
      lstat(p) {
        if (p === root) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return defaultFs.lstat(p);
      },
    };
    const landed = canonicalLanding(join(root, 'child'), fs);
    expect(landed.error).toEqual({ path: root, code: 'EACCES' });
    expect(insideTrust(join(root, 'child'), [root], root, home, fs)).toBe(false);
  });

  test('a backtick in a protected checkout is refused', () => {
    const yaml = migratedTeamYaml().replace('protected: [.]', 'protected: [".", "`x"]');
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.some((error) => error.message.includes('workspace.protected'))).toBe(true);
  });

  test('a trust entry covering the approval store is detected', async () => {
    // The store's own folder, spelled through `~`: only the approval-store check can refuse it.
    const store = storePath('acme', root, home);
    const yaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ~/.config/team/${store.split('/').pop()}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const run = await runApproveCmd();
    expect(run.code).not.toBe(0);
    expect(run.err).toContain('approval store');
    expect(run.err).toContain('.config/team');
  });

  test('a migrated file listing "/", the home, or a folder above them is refused at load, naming the entry', () => {
    const cases: [string, string, RegExp][] = [
      ['/', '/', /root of the filesystem/],
      ['"~"', '~', /is the home itself/],
      [home, home, /is the home itself/],
      [join(home, '.config', 'team'), join(home, '.config', 'team'), /holds the lobby and the approval store/],
      [base, base, /holds the lobby and the approval store/],
    ];
    for (const [written, value, reason] of cases) {
      const yaml = migratedTeamYaml().replace('trust:\n', `trust:\n  - ${written}\n`);
      writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
      const loaded = loadTeamFile(root, { home });
      expect(loaded.ok).toBe(false);
      if (loaded.ok) continue;
      const text = loaded.errors.map((error) => error.message).join('\n');
      expect(text).toContain(`trust: "${value}"`);
      expect(text).toMatch(reason);
    }
  });

  test('the project root, a folder under it, the lobby, and a worktrees folder beside the project stay acceptable', () => {
    const yaml = migratedTeamYaml().replace('  - ~/.config/team/lobby\n', `  - ~/.config/team/lobby\n  - ${join(root, 'notes')}\n`);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
  });

  test('the launch uses the gate\'s canonical lobby when the home is reached through a link', async () => {
    const realHome = join(base, 'real', 'home');
    mkdirSync(realHome, { recursive: true });
    const link = join(base, 'link');
    symlinkSync(join(base, 'real'), link, 'dir');
    const homeLink = join(link, 'home');
    const canonical = lobbyDir(realHome);
    expect(lobbyDir(homeLink)).not.toBe(canonical);
    // The file names the link-free entry; the launch must use the gate's canonical one.
    approveYaml(migratedTeamYaml().replace('~/.config/team/lobby', canonical), homeLink);

    const made = world();
    const run = await runUpCmd([], made, { home: homeLink });
    expect(run.code).toBe(0);
    expect(made.workspaces).toContainEqual({ label: 'lead', cwd: canonical });
    expect(made.workspaces).toContainEqual({ label: 'worker', cwd: canonical });
    const state = readState(dir);
    expect(state.sessions['acme']?.seats['lead']?.start_cwd).toBe(canonical);
    expect(state.sessions['acme']?.seats['worker']?.start_cwd).toBe(canonical);
  });

  test('a temporary add launched through a linked home lands in the canonical lobby', async () => {
    const realHome = join(base, 'real', 'home');
    mkdirSync(realHome, { recursive: true });
    const link = join(base, 'link');
    symlinkSync(join(base, 'real'), link, 'dir');
    const homeLink = join(link, 'home');
    const canonical = lobbyDir(realHome);
    approveYaml(migratedTeamYaml().replace('~/.config/team/lobby', canonical), homeLink);

    const made = world();
    expect((await runUpCmd([], made, { home: homeLink })).code).toBe(0);
    const before = made.workspaces.length;
    const addRun = await runAddCmd(['--temporary', '--like', 'worker', '--until', 'merged:main'], made, { home: homeLink });
    expect(addRun.code).toBe(0);
    expect(made.workspaces.slice(before)).toContainEqual({ label: 'worker-tmp-1', cwd: canonical });
  });

  test('an existing lobby with a looser mode is refused, never repaired', () => {
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o755);
    const res = verifyLobby(home, { create: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.text).toContain('not 0700');
    expect(statSync(lobby).mode & 0o7777).toBe(0o755);
  });

  test('doctor notes a migrated file that has never been approved', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const doc = await runDoctorCmd();
    expect(doc.out).toContain('the file is legacy: migrate');
  });

  test('a resumed launch from a migrated approved file keeps the recorded start folder', async () => {
    approveYaml(migratedTeamYaml());
    mkdirSync(lobby, { recursive: true });
    chmodSync(lobby, 0o700);
    updateState(dir, (st) => {
      st.sessions['acme'] = {
        seats: {
          lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', start_cwd: lobby },
          worker: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', start_cwd: lobby },
        },
        worktrees: {},
      };
    });
    const made = world();
    made.session = 'running';
    const run = await runUpCmd([], made, {
      sessionRunning: () => true,
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: lobby },
        { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: lobby },
      ],
      workspaces: () => [{ id: 'w0' }, { id: 'w1' }],
    });
    expect(run.err).not.toContain('the file is legacy');
    expect(run.code).toBe(0);
    const state = readState(dir);
    expect(state.sessions['acme']?.seats.lead?.start_cwd).toBe(lobby);
    expect(state.sessions['acme']?.seats.worker?.start_cwd).toBe(lobby);
  });

  test('every migrated seat starts in the lobby', () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), migratedTeamYaml());
    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    for (const seat of loaded.team.seats) {
      expect(seatStart(loaded.team, seat, root, home)).toEqual({ cwd: lobby, lobby: true });
    }
  });

  test('creating the lobby waits until a launch will actually happen', async () => {
    approveYaml(migratedTeamYaml());
    const made = world();
    const run = await runUpCmd([], made, {
      seatBudget: () => ({ kind: 'refuse', why: 'the account is spent' }),
    });
    expect(existsSync(lobby)).toBe(false);
    expect(made.workspaces.some((workspace) => workspace.label !== 'watchdog')).toBe(false);
    expect(run.out).toContain('the account is spent');
  });
});
