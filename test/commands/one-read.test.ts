// One read of the approval store per command: the security review's first must-fix.
// Every command takes its standing once, at its gate, and every value below it — the
// budgets, the watch values, the checks, the ceilings — derives from that snapshot.
//
// The counts go through each command's `standing` seam, which stands in for the one
// real read. The swap after the gate is real, not injected: the first ask poisons the
// record on disk, so a second read — through the seam or straight from the store —
// sees a refused record, and the command's own output would change. A command that
// still does what the gate said has read the store once.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runDown } from '../../src/commands/down.ts';
import { runInit } from '../../src/commands/init.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type UpSources } from '../../src/commands/up.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import type { Launch } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { Live } from '../../src/status/compare.ts';
import { approvalStanding, storePath, writeApproval, type Standing } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';
import type { Machine } from '../../src/watch/machine.ts';

const NOW = new Date('2026-10-04T00:00:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  limit: 8
budgets:
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
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
`;

let base: string;
let project: string;
let file: string;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-one-read-')));
  project = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(project, '.agents'), { recursive: true });
  mkdirSync(home);
  file = join(project, '.agents', 'team.yaml');
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
  writeFileSync(file, FILE);
  const loaded = loadTeamFile(project);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: FILE },
    loaded.team.seats,
    home,
    NOW,
  );
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const owner = { kind: 'owner' } as const;

/** A standing seam that counts its asks; the first ask poisons the record on disk, so any
 *  later read — the seam's own or a helper's straight from the store — sees a refused one. */
function gateThenPoison(): { reads(): number; standing(root: string): Standing } {
  let asks = 0;
  return {
    reads: () => asks,
    standing(root) {
      asks++;
      const standing = approvalStanding(root, home);
      if (asks === 1) writeFileSync(join(storePath('acme', project, home), 'approval.json'), '{ this is not a record');
      return standing;
    },
  };
}

/** The record broken before the command starts: a command that never reads the store is
 *  not stopped by it. */
function poison(): void {
  writeFileSync(join(storePath('acme', project, home), 'approval.json'), '{ this is not a record');
}

function doctorSources(): DoctorSources {
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

describe('one read of the approval store per command', () => {
  test('up: one gate, and the launch holds what it said', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runUp(['--dry-run', '--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctorSources(),
      standing: gate.standing,
    } satisfies Partial<UpSources> as UpSources);
    expect(code).toBe(0);
    expect(gate.reads()).toBe(1);
  });

  test('add: one gate, and the seat starts from the approved copy', async () => {
    const panes = new Map<string, { text: string; agent: boolean }>();
    let n = 0;
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace(_session, _cwd, label) {
        n++;
        panes.set(`w${n}:p1`, { text: IDLE, agent: false });
        return { pane: `w${n}:p1`, workspace: `w${n}` };
      },
      paneRun(_session, pane) {
        const known = panes.get(pane);
        if (known) known.agent = true;
        return true;
      },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
      paneText: (_session, pane) => panes.get(pane)?.text ?? '',
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runAdd(['worker', '--file', file], io, {
      home,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      doctor: doctorSources(),
      now: () => NOW,
      launch,
      standing: gate.standing,
    } satisfies AddSources);
    expect(code).toBe(0);
    expect(io.out).toContain('worker: ready');
    expect(gate.reads()).toBe(1);
  });

  test('doctor: one gate, and the ok line names the gate record', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runDoctor(['--file', file], io, { ...doctorSources(), standing: gate.standing });
    expect(code).toBe(0);
    expect(io.out).toContain('the file is the one the owner approved (approval #1, 2026-10-04');
    expect(io.out).not.toContain('does not verify');
    expect(gate.reads()).toBe(1);
  });

  test('status: one gate, and the table and the note hold its values', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runStatus(['--file', file, '--json'], io, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => 'main',
      standing: gate.standing,
      now: () => NOW,
      home,
    } satisfies StatusSources);
    expect(code).toBe(1); // the session is down: every seat is missing
    const doc = JSON.parse(io.out);
    expect(doc.notes.some((note: string) => note.startsWith('approval #1 (2026-10-04)'))).toBe(true);
    // The gate's budgets are in the table: the account the owner approved is a row.
    expect(doc.budgets?.map((row: { account: string }) => row.account)).toEqual(['openai']);
    expect(gate.reads()).toBe(1);
  });

  test('worktree: one gate', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runWorktree(['new', 'select-width', '--kind', 'fix', '--seat', 'lead', '--file', file], io, {
      home,
      now: () => NOW,
      standing: gate.standing,
    } satisfies WorktreeSources);
    expect(code).toBe(0);
    expect(gate.reads()).toBe(1);
  });

  test('remove --keep: one read, and only the amending branch makes it', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runRemove(['worker', '--keep', '--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      foreground: () => [],
      home,
      standing: gate.standing,
    } satisfies RemoveSources);
    expect(code).toBe(0);
    expect(gate.reads()).toBe(1);
    // The record was re-signed from the gate's own snapshot — a write, not another read —
    // so the amended file has no drift against it.
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    const loaded = loadTeamFile(project);
    expect(loaded.ok && approvalDifferences(loaded.team, project, home)).toEqual([]);
  });

  test('remove without --keep never reads the store, and a broken one stops nothing', async () => {
    poison();
    const io = testIo(project, owner);
    const code = await runRemove(['worker', '--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      foreground: () => [],
      home,
    } satisfies RemoveSources);
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('down never reads the store, and a broken one stops nothing', async () => {
    poison();
    const io = testIo(project, owner);
    const code = await runDown(['--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => [],
      now: () => NOW,
    });
    expect(code).toBe(0);
  });

  test('init --restore: one gate, and the copy it writes is the gate record\'s', async () => {
    unlinkSync(file);
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runInit(['--restore'], io, home, gate.standing);
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(FILE);
    expect(gate.reads()).toBe(1);
  });
});

describe('the watch reads the store once per pass', () => {
  test('two passes, two reads, one announce', async () => {
    let asks = 0;
    let passes = 2;
    const agent = (name: string): HerdrAgent => ({ name, agent: 'claude', pane: `${name}:p1`, workspace: name, status: 'working', cwd: null });
    const scene: Live = {
      running: true,
      agents: [agent('lead'), agent('worker')],
      workspaces: [{ id: 'lead', label: 'lead' }, { id: 'worker', label: 'worker' }],
      screens: { 'lead:p1': IDLE, 'worker:p1': IDLE },
    };
    const io = testIo(project, owner);
    const code = await runWatch(['--file', file], io, {
      live: () => scene,
      machine: () => fine,
      standing: (root) => {
        asks++;
        return approvalStanding(root, home);
      },
      readChecks: () => [],
      screen: () => IDLE,
      status: () => 'working',
      foreground: () => ['claude'],
      typeText: () => true,
      pressEnter: () => true,
      notify: () => {},
      now: () => NOW,
      wait: async () => --passes > 0,
      alive: () => false,
      pid: 4242,
    } satisfies WatchSources);
    expect(code).toBe(0);
    expect(asks).toBe(2);
    expect(io.out.match(/watching the session "acme"/g)?.length).toBe(1);
  });
});
