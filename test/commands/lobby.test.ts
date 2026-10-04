// A seat that works in worktrees never starts in a protected checkout: it waits in the lobby,
// beside the worktrees and inside trust, and `up` or `add` refuses the folder when it can't.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;

// Two implementers wait in the lobby; the coordinator reads in the project.
const BASE = `format: 1
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
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    count: 2
`;

let base: string;
let root: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function approve(text: string = BASE): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(root);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
  );
}

function doctor(): DoctorSources {
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
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

async function up(argv: string[], made: ReturnType<typeof world>) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => [],
    home,
    launch: made.launch,
  };
  const code = await runUp([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

async function add(argv: string[], made: ReturnType<typeof world>) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
  };
  const code = await runAdd([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lobby-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  lobby = join(base, 'worktrees', 'acme', '.lobby');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'live'), { recursive: true });
  mkdirSync(home);
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

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the lobby', () => {
  test('the dry run shows it: made once, used by each seat that works in worktrees, not by a shared one', async () => {
    approve();
    const run = await up(['--dry-run'], world());
    expect(run.code).toBe(0);
    expect(run.out).not.toContain('! up would refuse');
    expect(run.out.match(/\+ mkdir -p /g)).toHaveLength(1);
    expect(run.out).toContain(`+ mkdir -p ${lobby}\n`);
    expect(run.out).toContain(`+ herdr --session acme workspace create --cwd ${lobby} --label worker --no-focus\n`);
    expect(run.out).toContain(`+ herdr --session acme workspace create --cwd ${lobby} --label worker-2 --no-focus\n`);
    expect(run.out).toContain(`+ herdr --session acme workspace create --cwd ${root} --label lead --no-focus\n`);
  });

  test('a real run makes it and starts each seat that works in worktrees in it', async () => {
    approve();
    const made = world();
    const run = await up([], made);
    expect(run.code).toBe(0);
    expect(existsSync(lobby)).toBe(true);
    expect(made.workspaces).toEqual([
      { label: 'lead', cwd: root },
      { label: 'worker', cwd: lobby },
      { label: 'worker-2', cwd: lobby },
      { label: 'watchdog', cwd: root },
    ]);
    expect(made.renames).toEqual(['lead', 'worker', 'worker-2']);
  });

  test('a lobby outside trust is refused, once, naming the path and the patterns', async () => {
    approve(BASE.replace('  - ../worktrees/acme/*', '  - ../worktrees/acme/task'));
    const dry = await up(['--dry-run'], world());
    expect(dry.out.split('! up would refuse: the lobby').length).toBe(2);
    expect(dry.out).toContain(
      `! up would refuse: the lobby ../worktrees/acme/.lobby matches no trust pattern (., ../worktrees/acme/task): ` +
        'add one that covers it and run `team approve`\n',
    );
    expect(dry.out).not.toContain(`--cwd ${lobby}`);
    const made = world();
    const run = await up([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain('team up: the lobby ../worktrees/acme/.lobby matches no trust pattern');
    expect(run.out).toBe('');
    expect(made.workspaces).toEqual([]);
  });

  test('a seat aimed at a protected checkout is refused, naming the seat and the path', async () => {
    approve(BASE.replace('protected: [.]', 'protected: [., live]').replace('    count: 2', '    cwd: live'));
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain(
      "! up would refuse: seat worker would start in live, inside the protected checkout .; a seat that isn't `mode: shared` never starts in one\n",
    );
    expect(dry.out).not.toContain('--label worker');
    expect(dry.out).toContain(`--cwd ${root} --label lead`);
    const made = world();
    const run = await up([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain("team up: seat worker would start in live, inside the protected checkout .");
    expect(made.workspaces).toEqual([]);
  });

  test('a worktrees folder that is a symlink into the project is refused', async () => {
    mkdirSync(join(base, 'worktrees'), { recursive: true });
    symlinkSync(join(root, 'live'), join(base, 'worktrees', 'acme'), 'dir');
    approve();
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain(
      "! up would refuse: seat worker would start in the lobby ../worktrees/acme/.lobby, inside the protected checkout .; " +
        "a seat that isn't `mode: shared` never starts in one\n",
    );
    expect(dry.out).not.toContain('--label worker');
    expect(dry.out).toContain(`--cwd ${root} --label lead`);
    const made = world();
    const run = await up([], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      'team up: seat worker would start in the lobby ../worktrees/acme/.lobby, inside the protected checkout .',
    );
    expect(made.workspaces).toEqual([]);
    expect(existsSync(join(root, 'live', '.lobby'))).toBe(false);
  });

  test('add waits in the lobby too: a temporary seat with no worktree of its own', async () => {
    approve();
    const made = world();
    const run = await add(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], made);
    expect(run.code).toBe(0);
    expect(made.workspaces).toEqual([{ label: 'worker-tmp-1', cwd: lobby }]);
    expect(existsSync(lobby)).toBe(true);
  });

  test('add refuses a lobby outside trust, and leaves the file as it was', async () => {
    const text = BASE.replace('  - ../worktrees/acme/*', '  - ../worktrees/acme/task');
    approve(text);
    const made = world();
    const run = await add(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], made);
    expect(run.code).toBe(1);
    expect(run.err).toContain('team add: the lobby ../worktrees/acme/.lobby matches no trust pattern');
    expect(made.workspaces).toEqual([]);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(text);
  });
});
