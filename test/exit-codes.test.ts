// One run per row of contract/exit-codes.json. Each trigger is a temporary directory and the
// injectable stand-ins the other command tests use: no herdr session, no user-level store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runApprove, type ApproveSources } from '../src/commands/approve.ts';
import { check, loadConfig, type LoadConfig } from '../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runInit } from '../src/commands/init.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { runWorktree, type WorktreeSources } from '../src/commands/worktree.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { main, reportFailure, version } from '../src/cli.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { overridesPath } from '../src/profiles/overrides.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';
import { codesOf, loadContract, problems, render, uncovered } from '../scripts/exit-codes.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const owner = { kind: 'owner' } as const;
const other = { kind: 'seat', name: 'other', pane: 'w9:p1' } as const;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };
const quiet: Live = { running: false, agents: [], workspaces: [], screens: {} };
const running: Live = {
  running: true,
  agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'working', cwd: null }],
  workspaces: [{ id: 'w1', label: 'lead' }],
  screens: { 'w1:p1': `❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n  ⏵⏵ bypass permissions on\n` },
};

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
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

const TWO = `${TEAM}  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

const CHECKED = `format: 1
project: acme
coordinator: lead
operator: lead
identity:
  humans: [test@example.com]
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

const WORKTREE = `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
identity:
  forbidden_public:
    - "\\\\bWEB-[0-9]+\\\\b"
trust:
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Place = { base: string; root: string; home: string; file: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function layout(repo: boolean): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-exit-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  if (repo) {
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'acme\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'first');
  }
  return { base, root, home, file: join(root, '.agents', 'team.yaml') };
}

async function hold(repo: boolean, run: (place: Place) => Promise<number>): Promise<number> {
  const place = layout(repo);
  try {
    return await run(place);
  } finally {
    rmSync(place.base, { recursive: true, force: true });
  }
}

function write(place: Place, text: string): void {
  writeFileSync(place.file, text);
}

function approve(place: Place, text: string): void {
  write(place, text);
  const loaded = loadTeamFile(place.root, { file: place.file });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, place.home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
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

function launch(): Launch {
  return {
    sessionState: () => 'absent',
    startServer: () => false,
    sessionUp: () => false,
    createWorkspace: () => null,
    paneRun: () => false,
    renameAgent: () => false,
    closeWorkspace: () => false,
    agentPanes: () => [],
    paneText: () => '',
    foreground: () => null,
    sleep: async () => {},
    now: () => NOW,
  };
}

function addSources(place: Place, over: Partial<AddSources> = {}): AddSources {
  return {
    home: place.home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(place.home),
    now: () => NOW,
    launch: launch(),
    ...over,
  };
}

function downSources(over: Partial<RemoveSources> = {}): RemoveSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => null,
    now: () => NOW,
    ...over,
  } as RemoveSources;
}

function statusSources(live: Live | null, approval: string[] | null): StatusSources {
  return {
    live: () => live,
    branch: () => 'main',
    approval: () => approval,
    watchInForce: (team) => team.watch,
    budgetsInForce: (team) => team.budgets,
    now: () => NOW,
  };
}

function watchSources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => null,
    machine: () => fine,
    approval: () => [],
    watchInForce: (team) => team.watch,
    budgetsInForce: (team) => team.budgets,
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    notify: () => {},
    now: () => NOW,
    wait: async () => false,
    alive: () => false,
    pid: 1,
    ...over,
  };
}

function upSources(place: Place): UpSources {
  return { sessionRunning: () => false, agents: () => [], home: place.home, now: () => NOW };
}

function worktreeSources(place: Place): WorktreeSources {
  return { home: place.home, now: () => NOW };
}

function approveSources(place: Place, answer: string | null, home = place.home): ApproveSources {
  return { ask: async () => answer, now: () => NOW, home };
}

function loader(place: Place): LoadConfig {
  return (cwd, file) => loadConfig(cwd, file, place.home);
}

const agent = (name: string, status = 'working'): HerdrAgent => ({
  name,
  agent: 'claude',
  pane: 'w1:p1',
  workspace: 'w1',
  status,
  cwd: null,
});

type Ran = { code: number; out: string; err: string };

async function added(place: Place, argv: string[], caller: Caller, sources: AddSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runAdd(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

const triggers = new Map<string, () => Promise<number>>();

function on(command: string, code: number, meaning: string, run: () => Promise<number>): void {
  triggers.set(`${command}\t${code}\t${meaning}`, run);
}

on('add', 0, 'a dry run printed the plan', () => hold(true, async (place) => {
  approve(place, TWO);
  const ran = await added(place, ['worker', '--dry-run', '--file', place.file], owner, addSources(place));
  expect(ran.out).toContain('dry run: nothing was run');
  return ran.code;
}));

on('add', 1, "herdr doesn't answer", () => hold(true, async (place) => {
  approve(place, TWO);
  const ran = await added(place, ['worker', '--file', place.file], owner, addSources(place, { sessionState: () => null }));
  expect(ran.err).toContain("herdr doesn't answer");
  return ran.code;
}));

on('add', 1, 'the caller may not change the team', () => hold(true, async (place) => {
  write(place, TWO);
  const ran = await added(place, ['worker'], other, addSources(place));
  expect(ran.err).toContain('only the owner, the coordinator or the operator');
  return ran.code;
}));

on('add', 1, 'the file was never approved', () => hold(true, async (place) => {
  write(place, TWO);
  const ran = await added(place, ['worker', '--file', place.file], owner, addSources(place));
  expect(ran.err).toContain('never approved');
  return ran.code;
}));

on('add', 1, 'the session can\'t be "default"', () => hold(true, async (place) => {
  write(place, TWO);
  const ran = await added(place, ['worker', '--session', 'default', '--file', place.file], owner, addSources(place));
  expect(ran.err).toContain('can\'t be "default"');
  return ran.code;
}));

on('add', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const ran = await added(place, [], owner, addSources(place));
  expect(ran.err).toContain('a seat name is required');
  return ran.code;
}));

on('add', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const ran = await added(place, ['worker', '--file', 'missing.yaml'], owner, addSources(place));
  expect(ran.err).toContain('no team file');
  return ran.code;
}));

on('approve', 0, 'the comparison was printed', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runApprove(['--show', '--file', place.file], io, approveSources(place, null));
  expect(io.out).toContain('Seats: 1');
  return code;
}));

on('approve', 0, 'the owner approved the file', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runApprove(['--file', place.file], io, approveSources(place, '1'));
  expect(io.out).toContain('Approved.');
  return code;
}));

on('approve', 1, 'a seat ran it', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, other);
  const code = await runApprove(['--file', place.file], io, approveSources(place, '1'));
  expect(io.err).toContain('only the owner approves');
  return code;
}));

on('approve', 1, 'the answer was not the number of seats', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runApprove(['--file', place.file], io, approveSources(place, '0'));
  expect(io.err).toContain('not approved');
  return code;
}));

on('approve', 1, 'the approval store sits where seats work', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runApprove(['--file', place.file], io, approveSources(place, '1', place.root));
  expect(io.err).toContain('where seats work');
  return code;
}));

on('approve', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runApprove(['extra'], io, approveSources(place, null));
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('approve', 2, 'the overrides file can\'t be parsed', () => hold(true, async (place) => {
  write(place, TEAM);
  const loaded = loadTeamFile(place.root, { file: place.file });
  if (!loaded.ok) throw new Error('team file');
  const path = overridesPath(loaded.team.project, loaded.root, place.home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'format: [\n');
  const io = testIo(place.root, owner);
  const code = await runApprove(['--file', place.file], io, approveSources(place, '1'));
  expect(io.err).toContain('line');
  return code;
}));

on('approve', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runApprove(['--file', 'missing.yaml'], io, approveSources(place, null));
  expect(io.err).toContain('no team file');
  return code;
}));

on('check', 0, 'every commit passed', () => hold(true, async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  const code = await check(['HEAD', '--file', place.file], io, loader(place));
  expect(io.out).toContain('ok');
  return code;
}));

on('check', 1, 'a commit was refused', () => hold(true, async (place) => {
  write(place, CHECKED);
  writeFileSync(join(place.root, 'note.txt'), 'note\n');
  git(place.root, 'add', 'note.txt');
  execFileSync('git', ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '-m', 'fix: unsigned'], {
    cwd: place.root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = git(place.root, 'rev-parse', 'HEAD').trim();
  const io = testIo(place.root, owner);
  const code = await check([sha, '--file', place.file], io, loader(place));
  expect(io.out).toContain('refused');
  return code;
}));

on('check', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await check([], io, loader(place));
  expect(io.err).toContain('a <ref> is required');
  return code;
}));

on('check', 2, 'the pull request body can\'t be read', () => hold(true, async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  const code = await check(['HEAD', '--pr', 'missing.md', '--file', place.file], io, loader(place));
  expect(io.err).toContain("can't read the pull request body");
  return code;
}));

on('check', 2, 'the ref names nothing', () => hold(true, async (place) => {
  write(place, CHECKED);
  const io = testIo(place.root, owner);
  const code = await check(['not-a-ref', '--file', place.file], io, loader(place));
  expect(io.err).toContain('not-a-ref');
  return code;
}));

on('check', 2, 'the team file can\'t be read', () => hold(true, async (place) => {
  const io = testIo(place.root, owner);
  const code = await check(['HEAD'], io, loader(place));
  expect(io.err).toContain('no team file');
  return code;
}));

on('conformance-adapter', 0, 'the protocol finished', async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const proc = Bun.spawn(['bun', 'src/cli.ts', 'conformance-adapter'], {
    cwd: repo,
    stdin: new Uint8Array(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.exited;
});

on('doctor', 0, 'nothing is missing', () => hold(true, async (place) => {
  approve(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDoctor(['--file', place.file], io, doctor(place.home));
  expect(io.out).toContain('nothing missing');
  return code;
}));

on('doctor', 1, 'something is missing', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDoctor(['--file', place.file], io, doctor(place.home));
  expect(io.out).toContain('MISS');
  return code;
}));

on('doctor', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runDoctor(['extra'], io, doctor(place.home));
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('doctor', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runDoctor(['--file', 'missing.yaml'], io, doctor(place.home));
  expect(io.err).toContain('no team file');
  return code;
}));

on('down', 0, 'a dry run printed the plan', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDown(['--dry-run', '--file', place.file], io, downSources({ sessionRunning: () => true }));
  expect(io.out).toContain('dry run: nothing was run');
  return code;
}));

on('down', 0, 'there was nothing to stop', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDown(['--file', place.file], io, downSources());
  expect(io.out).toContain('nothing to stop');
  return code;
}));

on('down', 1, 'the run was refused', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, other);
  const code = await runDown(['--file', place.file], io, downSources({ sessionRunning: () => true }) satisfies DownSources);
  expect(io.err).toContain('only the owner, the coordinator or the operator');
  return code;
}));

on('down', 1, 'this call has no way to reach herdr', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDown(['--file', place.file], io, downSources({ sessionRunning: () => true }));
  expect(io.err).toContain('no way to reach herdr');
  return code;
}));

on('down', 2, "herdr doesn't answer", () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDown(['--file', place.file], io, downSources({ sessionRunning: () => null }));
  expect(io.err).toContain("doesn't answer");
  return code;
}));

on('down', 2, 'the agents can\'t be read', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runDown(['--file', place.file], io, downSources({ sessionRunning: () => true, agents: () => null }));
  expect(io.err).toContain("can't be read");
  return code;
}));

on('down', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runDown(['extra'], io, downSources());
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('down', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runDown(['--file', 'missing.yaml'], io, downSources());
  expect(io.err).toContain('no team file');
  return code;
}));

on('init', 0, 'a skeleton was written', () => hold(true, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runInit([], io, place.home);
  expect(io.out).toContain('Wrote');
  return code;
}));

on('init', 0, 'the approved copy was restored', () => hold(true, async (place) => {
  const io = testIo(place.root, owner);
  expect(await runInit([], io, place.home)).toBe(0);
  const text = readFileSync(place.file, 'utf8');
  const loaded = loadTeamFile(place.root);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, place.home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
  );
  rmSync(place.file);
  const again = testIo(place.root, owner);
  const code = await runInit(['--restore'], again, place.home);
  expect(again.out).toContain('Restored');
  return code;
}));

on('init', 1, 'not the owner', () => hold(true, async (place) => {
  const io = testIo(place.root, other);
  const code = await runInit([], io, place.home);
  expect(io.err).toContain('only the owner runs init');
  return code;
}));

on('init', 1, 'the team file already exists', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runInit([], io, place.home);
  expect(io.err).toContain('exists already');
  return code;
}));

on('init', 1, 'the team file is tracked', () => hold(true, async (place) => {
  write(place, TEAM);
  git(place.root, 'add', '.agents/team.yaml');
  git(place.root, 'commit', '-q', '-m', 'track the team file');
  const io = testIo(place.root, owner);
  const code = await runInit([], io, place.home);
  expect(io.err).toContain('tracked by git');
  return code;
}));

on('init', 1, 'there is nothing to restore', () => hold(true, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runInit(['--restore'], io, place.home);
  expect(io.err).toContain('nothing to restore');
  return code;
}));

on('init', 2, 'not inside a git repository', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runInit([], io, place.home);
  expect(io.err).toContain('not inside a git repository');
  return code;
}));

on('init', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runInit(['extra'], io, place.home);
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('remove', 0, 'the seat was removed', () => hold(true, async (place) => {
  write(place, TWO);
  const io = testIo(place.root, owner);
  const code = await runRemove(['worker'], io, downSources({ home: place.home }));
  expect(io.out).toContain('removed worker');
  return code;
}));

on('remove', 1, "herdr doesn't answer", () => hold(true, async (place) => {
  write(place, TWO);
  const io = testIo(place.root, owner);
  const code = await runRemove(['worker'], io, downSources({ sessionRunning: () => null, home: place.home }));
  expect(io.err).toContain("doesn't answer");
  return code;
}));

on('remove', 1, 'the caller may not change the team', () => hold(true, async (place) => {
  write(place, TWO);
  const io = testIo(place.root, other);
  const code = await runRemove(['worker'], io, downSources({ home: place.home }));
  expect(io.err).toContain('only the owner, the coordinator or the operator');
  return code;
}));

on('remove', 1, 'the seat is not free', () => hold(true, async (place) => {
  write(place, TWO);
  const io = testIo(place.root, owner);
  const code = await runRemove(['worker'], io, downSources({
    sessionRunning: () => true,
    agents: () => [agent('worker')],
    screen: () => ({ kind: 'working' }),
    home: place.home,
  }));
  expect(io.err).toContain('is working');
  return code;
}));

on('remove', 1, 'the team has no such seat', () => hold(true, async (place) => {
  write(place, TWO);
  const io = testIo(place.root, owner);
  const code = await runRemove(['missing'], io, downSources({ home: place.home }));
  expect(io.err).toContain('no seat');
  return code;
}));

on('remove', 2, 'the edit would not validate', () => hold(true, async (place) => {
  write(place, TWO);
  const io = testIo(place.root, owner);
  const code = await runRemove(['lead'], io, downSources({ home: place.home }));
  expect(io.err).toContain('coordinator');
  return code;
}));

on('remove', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runRemove([], io, downSources());
  expect(io.err).toContain('a seat name is required');
  return code;
}));

on('remove', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runRemove(['worker', '--file', 'missing.yaml'], io, downSources());
  expect(io.err).toContain('no team file');
  return code;
}));

on('status', 0, 'the file, the state and the session agree', () => hold(true, async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    state.sessions.acme = { ...emptySession(), watch: { pid: 1, heartbeat: NOW.toISOString() } };
  });
  const io = testIo(place.root, owner);
  const code = await runStatus(['--file', place.file], io, statusSources(running, []));
  expect(io.out).toContain('0 difference');
  return code;
}));

on('status', 1, 'there is a difference', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runStatus(['--file', place.file], io, statusSources(running, null));
  expect(io.out).toContain('never approved');
  return code;
}));

on('status', 2, "herdr doesn't answer", () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runStatus(['--file', place.file], io, statusSources(null, []));
  expect(io.err).toContain("doesn't answer");
  return code;
}));

on('status', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runStatus(['extra'], io, statusSources(quiet, []));
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('status', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runStatus(['--file', 'missing.yaml'], io, statusSources(quiet, []));
  expect(io.err).toContain('no team file');
  return code;
}));

on('team', 0, "a command's help was printed", async () => {
  const io = testIo('.', owner);
  const code = await main(['status', '--help'], io);
  expect(io.out).toStartWith('Usage: team status');
  return code;
});

on('team', 0, 'help was printed', async () => {
  const io = testIo('.', owner);
  const code = await main(['--help'], io);
  expect(io.out).toContain('Usage: team <command>');
  return code;
});

on('team', 0, 'the version was printed', async () => {
  const io = testIo('.', owner);
  const code = await main(['--version'], io);
  expect(io.out.trim()).toBe(version());
  return code;
});

on('team', 1, 'a command threw', async () => {
  let err = '';
  const code = reportFailure(new Error('boom'), (text) => {
    err += text;
  });
  expect(err).toBe('team: boom\n');
  return code;
});

on('team', 2, 'no command was given', async () => {
  const io = testIo('.', owner);
  const code = await main([], io);
  expect(io.out).toContain('Usage: team <command>');
  return code;
});

on('team', 2, 'the command is unknown', async () => {
  const io = testIo('.', owner);
  const code = await main(['nosuch'], io);
  expect(io.err).toContain('unknown command "nosuch"');
  return code;
});

on('up', 0, 'a dry run printed the plan', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runUp(['--dry-run', '--file', place.file], io, upSources(place));
  expect(io.out).toContain('dry run: nothing was run');
  return code;
}));

on('up', 1, 'the run was refused', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runUp(['--file', place.file], io, upSources(place));
  expect(io.err).toContain('never approved');
  return code;
}));

on('up', 1, 'this call has no way to reach herdr', () => hold(true, async (place) => {
  approve(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runUp(['--file', place.file], io, upSources(place));
  expect(io.err).toContain('no way to reach herdr');
  return code;
}));

on('up', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runUp(['extra'], io, upSources(place));
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('up', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runUp(['--file', 'missing.yaml'], io, upSources(place));
  expect(io.err).toContain('no team file');
  return code;
}));

on('watch', 0, 'the watch ran and stopped', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runWatch(['--file', place.file], io, watchSources());
  expect(io.out).toContain('stopped');
  return code;
}));

on('watch', 1, 'a seat passed --no-nudge', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, other);
  const code = await runWatch(['--no-nudge', '--file', place.file], io, watchSources());
  expect(io.err).toContain("--no-nudge and --no-notify are the owner's");
  return code;
}));

on('watch', 1, 'a watch already runs', () => hold(true, async (place) => {
  write(place, TEAM);
  updateState(join(place.root, '.agents'), (state) => {
    state.sessions.acme = { ...emptySession(), watch: { pid: 99, heartbeat: NOW.toISOString() } };
  });
  const io = testIo(place.root, owner);
  const code = await runWatch(['--file', place.file], io, watchSources({ alive: (pid) => pid === 99 }));
  expect(io.err).toContain('already runs');
  return code;
}));

on('watch', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runWatch(['extra'], io, watchSources());
  expect(io.err).toContain('unexpected "extra"');
  return code;
}));

on('watch', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runWatch(['--file', 'missing.yaml'], io, watchSources());
  expect(io.err).toContain('no team file');
  return code;
}));

on('worktree', 0, 'the worktree was created', () => hold(false, async (place) => {
  const remote = join(place.base, 'remote.git');
  git(place.base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(place.root, 'init', '-q', '-b', 'main');
  git(place.root, 'config', 'user.name', 'Test');
  git(place.root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(place.root, 'README.md'), 'acme\n');
  git(place.root, 'add', 'README.md');
  git(place.root, 'commit', '-q', '-m', 'first');
  git(place.root, 'remote', 'add', 'origin', remote);
  git(place.root, 'push', '-q', '-u', 'origin', 'main');
  approve(place, WORKTREE);
  const io = testIo(place.root, owner);
  const code = await runWorktree(['new', 'select-width', '--kind', 'fix'], io, worktreeSources(place));
  expect(io.out).toContain('select-width');
  return code;
}));

on('worktree', 1, 'the caller may not change the team', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, other);
  const code = await runWorktree(['new', 'task'], io, worktreeSources(place));
  expect(io.err).toContain('only the owner, the coordinator or the operator');
  return code;
}));

on('worktree', 1, 'the file was never approved', () => hold(true, async (place) => {
  write(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runWorktree(['new', 'task'], io, worktreeSources(place));
  expect(io.err).toContain('never approved');
  return code;
}));

on('worktree', 1, 'the workspace is shared', () => hold(true, async (place) => {
  approve(place, TEAM);
  const io = testIo(place.root, owner);
  const code = await runWorktree(['new', 'task'], io, worktreeSources(place));
  expect(io.err).toContain('shared');
  return code;
}));

on('worktree', 2, 'the invocation can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runWorktree([], io, worktreeSources(place));
  expect(io.err).toContain('a subcommand is required');
  return code;
}));

on('worktree', 2, 'the team file can\'t be read', () => hold(false, async (place) => {
  const io = testIo(place.root, owner);
  const code = await runWorktree(['new', 'task', '--file', 'missing.yaml'], io, worktreeSources(place));
  expect(io.err).toContain('no team file');
  return code;
}));

const contract = loadContract();

test('the exit-code contract matches the commands and the page', () => {
  expect(problems()).toEqual([]);
});

test('a return the contract does not list fails the check', () => {
  const source = readFileSync(new URL('../src/commands/doctor.ts', import.meta.url), 'utf8');
  expect(uncovered('doctor', source, contract.rows)).toEqual([]);
  expect(codesOf(`${source}\nexport function added(): number {\n  return 9;\n}\n`)).toContain(9);
  expect(uncovered('doctor', `${source}\nexport function added(): number {\n  return 9;\n}\n`, contract.rows)).toEqual([9]);
});

test('the page is generated from the contract', () => {
  const page = readFileSync(new URL('../docs/reference/exit-codes.md', import.meta.url), 'utf8');
  expect(render(contract.rows)).toBe(page);
  const changed = contract.rows.map((row, index) => (index === 0 ? { ...row, meaning: 'changed on purpose' } : row));
  expect(render(changed)).not.toBe(page);
});

for (const row of contract.rows) {
  test(`${row.command} exits ${row.code}: ${row.meaning}`, async () => {
    const run = triggers.get(`${row.command}\t${row.code}\t${row.meaning}`);
    expect(run, `${row.command} ${row.code} ${row.meaning}`).toBeFunction();
    expect(await run!()).toBe(row.code);
  });
}
