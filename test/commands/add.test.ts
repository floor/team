import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { readState } from '../../src/state.ts';
import { readLedger, storePath, writeApproval } from '../../src/store/store.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = '❯ \n';

let base: string;
let project: string;
let home: string;

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    # the seat stays in this order
    stopped: true
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function approve(text: string = FILE): void {
  writeFileSync(join(project, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(project);
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

function world(): { launch: Launch; creates: string[]; renames: string[]; session: 'absent' | 'running' } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made = { launch: {} as Launch, creates: [] as string[], renames: [] as string[], session: 'absent' as 'absent' | 'running' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.creates.push(label);
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

function sources(made: ReturnType<typeof world>, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-')));
  project = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'branch', 'fix/fresh');
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const owner = { kind: 'owner' } as const;

describe('team add', () => {
  test('starts a stopped seat and drops only its stopped line', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made))).toBe(0);
    expect(made.creates).toEqual(['worker']);
    expect(made.renames).toEqual(['worker']);
    const text = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    expect(text).not.toContain('stopped:');
    expect(text).toContain('# the seat stays in this order');
    expect(text.indexOf('name: worker')).toBeLessThan(text.indexOf('# the seat stays in this order'));
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker?.stage).toBe('ready');
  });

  test('refuses a seat the approved file does not hold, and a caller who may not change the team', async () => {
    const missing = testIo(project, owner);
    expect(await runAdd(['nobody'], missing, sources(world()))).toBe(1);
    expect(missing.err).toContain('no seat');
    const seat = testIo(project, { kind: 'seat', name: 'stranger', pane: 'w1:p1' });
    expect(await runAdd(['worker'], seat, sources(world()))).toBe(1);
    expect(seat.err).toContain('only the owner, the coordinator or the operator');
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a temporary seat is recorded, not written into the file, and keeps its own-commits flag', async () => {
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], io, sources(made));
    expect(code).toBe(0);
    expect(made.renames).toEqual(['worker-tmp-1']);
    const text = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    expect(text).not.toContain('tmp');
    expect(text).toContain('stopped: true');
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-1'];
    expect(seat?.temporary).toEqual({ like: 'worker', until: 'merged:fix/fresh', own_commits: false });
    expect(readLedger(storePath('acme', project, home)).some((entry) => entry.display === 'Claude Opus 5.5')).toBe(true);
  });

  test('refuses a result that already exists and a merged branch that does not', async () => {
    writeFileSync(join(project, 'done.md'), 'done\n');
    const exists = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'result:done.md'], exists, sources(world()))).toBe(1);
    expect(exists.err).toContain('already exists');
    const gone = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:fix/missing'], gone, sources(world()))).toBe(1);
    expect(gone.err).toContain("doesn't exist");
  });

  test('names an unnamed agent already in the seat\'s workspace instead of launching another', async () => {
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9', label: 'lead' }],
    }));
    expect(code).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['lead']);
  });
});
