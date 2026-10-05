import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { readLedger, storePath, writeApproval } from '../../src/store/store.ts';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { rulesFilePath } from '../../src/launch/rules-file.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { testIo } from '../helpers.ts';
import type { Machine } from '../../src/watch/machine.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';

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
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    # the seat stays in this order
    stopped: true
  - role: implementer
    name: scribe
    label: scribe
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
    stopped: true
`;

// A file whose worker works in worktrees: it would start in the lobby, never the project root.
const WORKTREE_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  base: main
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
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: zsh ../tools/x.sh
    stopped: true
`;

function file(path: string, text = 'x\n'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function approve(text: string = FILE): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = text.includes('trust:')
    ? text
    : text.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\n`);
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
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
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
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
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
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
    expect(text).not.toMatch(/# the seat stays in this order\n    stopped: true/);
    expect(text).toContain('# the seat stays in this order');
    expect(text.indexOf('name: worker')).toBeLessThan(text.indexOf('# the seat stays in this order'));
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker?.stage).toBe('ready');
    const loaded = loadTeamFile(project, { home });
    expect(loaded.ok && approvalDifferences(loaded.team, project, home)).toEqual([]);
  });

  test('a dry run previews a launch-line refusal, creates nothing, and edits nothing', async () => {
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: team-deepseek --key x\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker', '--dry-run'], io, sources(made, {
      doctor: { ...doctor(), onPath: (binary) => binary !== 'team-deepseek' },
    }));
    // The refusal is previewed as the plan's own line, and the run exits 0: nothing was made and
    // the file was not touched — the seat would be started, and its line can't run.
    expect(code).toBe(0);
    expect(io.out).toContain(
      '  skip worker: would refuse: its launch line starts `team-deepseek`, which is not on the PATH\n',
    );
    expect(io.out).toContain('dry run: nothing was run\n');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a real add refuses that seat with the file left as it was', async () => {
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: team-deepseek --key x\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      doctor: { ...doctor(), onPath: (binary) => binary !== 'team-deepseek' },
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('team add: worker: its launch line starts `team-deepseek`, which is not on the PATH\n');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('a line for an existing unnamed pane is checked where that pane runs', async () => {
    // The reviewer's probe: the state records the seat at pane `w9:p1` with `start_cwd` at the
    // project root — where `../tools/x.sh` is a file — and the fresh seat would start in the
    // lobby, where it is not. The seat is adopted into the pane, not launched, so the recorded
    // folder is where its line is read: the line resolves, nothing is refused, nothing is made.
    approve(WORKTREE_FILE);
    file(join(base, 'tools', 'x.sh'));
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', start_cwd: '.' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).not.toContain('would refuse');
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['worker']);
  });

  test('a line for an existing pane whose state records no start folder is noted, not checked', async () => {
    approve(WORKTREE_FILE);
    file(join(base, 'tools', 'x.sh'));
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).toContain(
      '  note worker: its launch line was not checked: the seat is resumed and its state records no start folder\n',
    );
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['worker']);
  });

  test('a miss at the recorded folder does not refuse a seat that is adopted, not launched', async () => {
    // The pane runs in the lobby, where the line does not resolve: a miss there keeps `up`'s
    // rule — a seat that is not launched is not refused for its line — and the seat is renamed.
    approve(WORKTREE_FILE);
    file(join(base, 'tools', 'x.sh'));
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', start_cwd: '../worktrees/acme/.lobby' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).not.toContain('would refuse');
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['worker']);
  });

  test('a line the check cannot read is noted once, and the seat still starts', async () => {
    approve(FILE.replace(
      'launch: claude --model claude-opus-5-5\n    # the seat stays in this order',
      'launch: claude --model claude-opus-5-5 --append-system-prompt "be terse"\n    # the seat stays in this order',
    ));
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(0);
    expect(io.err.split('  note worker: its launch line was not checked').length).toBe(2);
    expect(io.out).not.toContain('note worker');
    expect(made.creates).toEqual(['worker']);
    // the added seat is unstopped; the fixture's other stopped seat keeps its flag
    expect(readFileSync(join(project, '.agents/team.yaml'), 'utf8')).not.toMatch(/# the seat stays in this order\n    stopped: true/);
  });

  test('add after a clean remove --keep leaves no drift', async () => {
    approve(FILE.replace('\n    stopped: true', ''));
    const removeSources: RemoveSources = {
      sessionRunning: () => true,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      sleep: async () => {},
      launch: {
        typeText: () => true,
        pressEnter: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => false,
        deleteSession: () => false,
        kill: () => false,
        sleep: async () => {},
        now: () => NOW,
      },
      foreground: () => [],
      home,
    };
    expect(await runRemove(['worker', '--keep'], testIo(project, owner), removeSources)).toBe(0);
    const kept = loadTeamFile(project, { home });
    expect(kept.ok && approvalDifferences(kept.team, project, home)).toEqual([]);
    expect(await runAdd(['worker'], testIo(project, owner), sources(world()))).toBe(0);
    const after = loadTeamFile(project, { home });
    expect(after.ok && approvalDifferences(after.team, project, home)).toEqual([]);
    expect(after.ok && after.team.seats.find((seat) => seat.name === 'worker')?.stopped).toBe(false);
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

  test('a refused caller is refused before any record: the plain sentence, no seat record, no log line', async () => {
    // The gate sits before the writer is built: a refused caller prints the refusal exactly as
    // main prints it — the sentence, nothing wrapped around it — and nothing that reads as a
    // progress record is written anywhere: stdout is empty, and the log file's bytes are what
    // they were before the run.
    const io = testIo(project, { kind: 'seat', name: 'stranger', pane: 'w1:p1' });
    const log = join(project, '.agents', 'team.log');
    const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : null);
    const before = logged();
    expect(await runAdd(['worker'], io, sources(world()))).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team add: only the owner, the coordinator or the operator runs it; this call is stranger\n');
    expect(logged()).toBe(before);
  });

  test('a temporary seat is recorded, not written into the file, keeps its own-commits flag, and the log holds its record alone', async () => {
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['--temporary', '--like', 'worker', '--until', 'merged:fix/fresh'], io, sources(made));
    expect(code).toBe(0);
    // A redirected stdout holds the seat's one record, and records alone.
    expect(io.out).toBe('worker-tmp-1: ready\n');
    expect(made.renames).toEqual(['worker-tmp-1']);
    const text = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    const loaded = loadTeamFile(project, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('\n'));
    expect(loaded.team.seats.map((seat) => seat.name)).not.toContain('worker-tmp-1');
    expect(text).toContain('stopped: true');
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['worker-tmp-1'];
    expect(seat?.temporary).toEqual({ like: 'worker', until: 'merged:fix/fresh', own_commits: false });
    expect(readLedger(storePath('acme', project, home)).some((entry) => entry.display === 'Claude Opus 5.5')).toBe(true);
    // One line per final record: the log holds the seat's record alone, never the separate
    // `started <seat>` line `add` used to write beside it. The temporary facts stay in the
    // state file and the seat's doctor/status reading.
    const log = readFileSync(join(project, '.agents', 'team.log'), 'utf8');
    const mine = log.split('\n').filter((line) => line.includes('worker-tmp-1'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('worker-tmp-1: ready');
    expect(log).not.toContain('started worker-tmp-1');
    expect(log).not.toContain('until merged:fix/fresh');
  });

  test('a temporary message seat at a dialog waits for its owner', async () => {
    const made = world();
    // The pane comes up at a trust question. §6: `add` never prompts and never closes — the
    // workspace is kept, the seat is recorded as waiting for its owner, nothing is sent into
    // the pane, and the owner finishes it with `team up`.
    const trust = readFileSync(new URL('../fixtures/codex/0.157.0/trust.txt', import.meta.url), 'utf8');
    const plain = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      const text = plain(session, pane);
      return text === IDLE ? trust : text;
    };
    const closes: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
    // The rules file is written only when the rules are delivered, and this seat never reached
    // its prompt: nothing was typed, so no file exists. It is the `team up` finish that types.
    const file = rulesFilePath('acme', project, home, 'scribe-tmp-1') as string;
    const io = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'scribe', '--until', 'merged:fix/fresh'], io, sources(made))).toBe(1);
    expect(io.out).toContain('scribe-tmp-1: left out: trust\n');
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(closes).toEqual([]);
    expect(existsSync(file)).toBe(false);
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['scribe-tmp-1'];
    expect(seat?.waiting).toMatchObject({ state: 'waiting-owner', classification: 'trust' });
    expect(seat?.temporary).toMatchObject({ like: 'scribe', until: 'merged:fix/fresh' });
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

  test('each start limit refuses with its figure before the file is edited', async () => {
    const cases: { machine: Machine; text: string }[] = [
      { machine: { ...fine, loadPerCore: 9 }, text: 'the load is 9.0 per core, above 3' },
      { machine: { ...fine, memoryFree: 10 }, text: 'free memory is 10%, below 25%' },
      { machine: { ...fine, swapFree: 1.1e9 }, text: 'free swap is 1.1 GB, below 2.0 GB' },
    ];
    for (const item of cases) {
      const made = world();
      const io = testIo(project, owner);
      expect(await runAdd(['worker'], io, sources(made, { machine: () => item.machine }))).toBe(1);
      expect(io.err).toContain(item.text);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
    }
  });

  test('swap that grows before the launch is refused, and the file stays', async () => {
    let reads = 0;
    const made = world();
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      machine: () => {
        reads += 1;
        return { ...fine, swapUsed: reads >= 2 ? 3e9 : 1e9 };
      },
    }));
    expect(code).toBe(1);
    expect(io.err).toContain('swap grew by 2.0 GB in 10 minutes, above 1.0 GB');
    expect(made.creates).toEqual([]);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain('stopped: true');
  });

  test('readings inside every limit still start the seat', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['worker'], io, sources(made, { machine: () => fine }))).toBe(0);
    expect(made.creates).toEqual(['worker']);
  });

  test('names an unnamed agent already in the seat\'s workspace instead of launching another', async () => {
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.lead = { stage: 'launched', workspace: 'w9', pane: 'w9:p1' };
      state.sessions.acme = session;
    });
    const made = world();
    made.launch.paneText = () => IDLE;
    made.launch.agentPanes = () => ['w9:p1'];
    const agent: HerdrAgent = { name: null, agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    const io = testIo(project, owner);
    const code = await runAdd(['lead'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.renames).toEqual(['lead']);
  });

  test('a new seat found at a dialog waits for its owner: nothing is closed, and it exits 1', async () => {
    const made = world();
    const closed: string[] = [];
    made.launch.paneText = (_session, pane) => (pane === 'w1:p1' ? PERMISSION : IDLE);
    made.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(1);
    // §6: the workspace is kept for its owner — `team up` finishes the seat — and the record,
    // its stderr detail and the log all name the reading without claiming any close.
    const line = 'worker: left out: permission';
    expect(io.out).toContain(`${line}\n`);
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toContain(line);
    expect(closed).toEqual([]);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker)
      .toMatchObject({ waiting: { state: 'waiting-owner', classification: 'permission' } });
  });

  test('a new seat found at a question waits for its owner: kept, recorded, nothing typed', async () => {
    const made = world();
    // §6 covers each dialog the same way, and a question is one of them. The identity of the
    // pane's process is read then and goes in the same write, for the owner's later `team up`.
    const question = readFileSync(new URL('../fixtures/claude-code/2.1.289/question-plain.txt', import.meta.url), 'utf8');
    const plain = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      const text = plain(session, pane);
      return text === IDLE ? question : text;
    };
    const closed: string[] = [];
    const sent: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
    made.launch.typeText = (_session, pane, text) => { sent.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { sent.push(`enter ${pane}`); return true; };
    made.launch.processInfo = () => ({ shell: 100, foreground: [101] });
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made));
    expect(code).toBe(1);
    expect(io.out).toContain('worker: left out: question\n');
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(closed).toEqual([]);
    expect(sent).toEqual([]);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.worker).toMatchObject({
      waiting: { state: 'waiting-owner', classification: 'question' },
      launched: { shell: 100, cli: [101] },
    });
  });

  test('a temporary seat found at a vendor notice waits for its owner, and nothing is typed', async () => {
    const made = world();
    // The Codex update screen is the vendor's own notice: still a dialog, still the owner's,
    // and never typed into.
    const notice = readFileSync(new URL('../fixtures/codex/0.157.0/startup.txt', import.meta.url), 'utf8');
    const plain = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      const text = plain(session, pane);
      return text === IDLE ? notice : text;
    };
    const closed: string[] = [];
    const sent: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closed.push(workspace); return true; };
    made.launch.typeText = (_session, pane, text) => { sent.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { sent.push(`enter ${pane}`); return true; };
    made.launch.processInfo = () => ({ shell: 200, foreground: [201] });
    const io = testIo(project, owner);
    expect(await runAdd(['--temporary', '--like', 'scribe', '--until', 'merged:fix/fresh'], io, sources(made))).toBe(1);
    expect(io.out).toContain('scribe-tmp-1: left out: vendor notice\n');
    expect(io.err).toContain('  the owner finishes it with `team up`\n');
    expect(closed).toEqual([]);
    expect(sent).toEqual([]);
    const seat = readState(join(project, '.agents')).sessions.acme?.seats['scribe-tmp-1'];
    expect(seat?.waiting).toMatchObject({ state: 'waiting-owner', classification: 'vendor notice' });
    expect(seat?.launched).toEqual({ shell: 200, cli: [201] });
  });

  test('a replaced seat is closed without input and launched fresh, not refused as running', async () => {
    // The recorded pane holds a CLI, and it is not the one team launched: the seat's name in
    // herdr's list is not the seat. `add` does what `up` does — closes that workspace without a
    // key or a text, clears the record, and launches fresh with the rules.
    updateState(join(project, '.agents'), (state) => {
      const session = state.sessions.acme ?? emptySession();
      session.seats.worker = { stage: 'launched', workspace: 'w9', pane: 'w9:p1', launched: { shell: 400, cli: [401] } };
      state.sessions.acme = session;
    });
    const made = world();
    const closes: string[] = [];
    const keys: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
    made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
    made.launch.typeText = (_session, pane, text) => { keys.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { keys.push(`enter ${pane}`); return true; };
    const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
    // The repair re-reads herdr immediately before the close: the list still names the seat on
    // its pane, and its screen reads idle, so the replaced seat's workspace may be closed.
    made.launch.agents = () => [listed];
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w9:p1' ? IDLE : text(session, pane));
    const io = testIo(project, owner);
    const code = await runAdd(['worker'], io, sources(made, {
      sessionState: () => 'running',
      agents: () => [listed],
      workspaces: () => [{ id: 'w9' }],
    }));
    expect(code).toBe(0);
    expect(io.err).not.toContain('already running');
    // The wrong process was typed into with nothing, and the workspace it sat in was closed; the
    // seat was launched in a fresh one, its rules carried by the launch line.
    expect(keys).toEqual([]);
    expect(closes).toEqual(['w9']);
    expect(made.creates).toEqual(['worker']);
    expect(io.err).toContain('  its pane held a process team did not launch; closed without input and launched again\n');
    const seats = readState(join(project, '.agents')).sessions.acme?.seats ?? {};
    expect(seats.worker?.stage).toBe('ready');
    expect(seats.worker?.pane).toBe('w1:p1');
  });

  describe('add exits 1 when its repair is refused with a stale record that says ready', () => {
    function setupReadySeat() {
      approve(WORKTREE_FILE);
      updateState(join(project, '.agents'), (state) => {
        const session = state.sessions.acme ?? emptySession();
        session.seats.worker = { stage: 'ready', workspace: 'w9', pane: 'w9:p1', launched: { shell: 400, cli: [401] } };
        state.sessions.acme = session;
      });
      const before = readFileSync(join(project, '.agents/team.state.json'), 'utf8');
      const made = world();
      const closes: string[] = [];
      made.launch.closeWorkspace = (_session, workspace) => { closes.push(workspace); return true; };
      const listed: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w9:p1', workspace: 'w9', status: 'idle', cwd: null };
      made.launch.agents = () => [listed];
      made.launch.paneText = () => IDLE;
      return { made, closes, listed, before };
    }

    test('agent list binding failed', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.agents = () => [];
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.out).toContain('worker: left out: herdr no longer shows this seat on its recorded pane; nothing closed; run team status\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('workspace holds other panes', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.workspacePanes = () => ['w9:p1', 'w9:p2'];
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.out).toContain('worker: left out: its workspace holds other panes; nothing closed (close its pane there, then run team up)\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('workspace read failed', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.workspacePanes = () => null;
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.out).toContain('worker: left out: its pane could not be read; nothing closed\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('process read failed', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      let reads = 0;
      made.launch.processInfo = () => {
        reads += 1;
        return reads === 1 ? { shell: 400, foreground: [500] } : null;
      };
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.out).toContain('worker: left out: its pane could not be read; nothing closed\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('process working', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.paneText = () => 'esc to interrupt';
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.out).toContain('worker: left out: the process in its pane is working; nothing closed (stop it there, or run team remove worker)\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('process unsent', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      const unsentText = readFileSync(join(import.meta.dir, '../fixtures/claude-code/2.1.289/unsent-typed-ansi.txt'), 'utf8');
      made.launch.processInfo = () => ({ shell: 400, foreground: [500] });
      made.launch.paneText = () => unsentText;
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.out).toContain('worker: left out: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove worker)\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('already running: answers as it does today for a seat that is already running', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toBe('team add: worker is already running\n');
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });

    test('restarts to same between plan and close', async () => {
      const { made, closes, listed, before } = setupReadySeat();
      let reads = 0;
      made.launch.processInfo = () => {
        reads += 1;
        return reads === 1 ? { shell: 400, foreground: [400] } : { shell: 400, foreground: [400, 401] };
      };
      const io = testIo(project, owner);
      const code = await runAdd(['worker'], io, sources(made, {
        sessionState: () => 'running',
        agents: () => [listed],
        workspaces: () => [{ id: 'w9' }],
      }));
      expect(code).toBe(1);
      expect(io.err).toContain('team add: worker is already running\n');
      expect(io.out).not.toContain("worker: its pane is the seat's again; left as it is\n");
      expect(closes).toEqual([]);
      expect(made.creates).toEqual([]);
      expect(readFileSync(join(project, '.agents/team.state.json'), 'utf8')).toBe(before);
    });
  });
});

