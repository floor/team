import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { testIo } from '../helpers.ts';

const RULE = '─'.repeat(40);
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n`;

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
`;

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };

let dir: string;
let file: string;

function agent(name: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${name}:p1`, workspace: name, status, cwd: null };
}

function scene(extra: HerdrAgent[] = []): Live {
  const agents = [agent('lead', 'working'), agent('worker', 'working'), ...extra];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: Object.fromEntries(agents.map((one) => [one.pane, idle])),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-watch-close-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, FILE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => scene(),
    machine: () => fine,
    approval: () => [],
    watchInForce: (team) => team.watch,
    screen: () => idle,
    status: () => 'idle',
    typeText: () => true,
    pressEnter: () => true,
    notify: () => {},
    now: () => new Date('2026-10-03T14:00:00Z'),
    wait: async () => false,
    alive: () => false,
    pid: 7,
    ...over,
  };
}

describe('the watch closes what its authority allows', () => {
  test('a temporary seat whose result exists, and that has worked and is free, is closed', async () => {
    writeFileSync(join(dir, 'done.md'), 'done\n');
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = {
        stage: 'ready', worked: true, temporary: { like: 'worker', until: 'result:done.md' },
      };
    });
    const stopped: string[] = [];
    const io = testIo(dir);
    const tmp = agent('worker-tmp-1', 'idle');
    await runWatch(['--file', file, '--no-nudge'], io, sources({
      live: () => scene([tmp]),
      stopSeat: async (_session, seat) => { stopped.push(seat.name); return true; },
    }));
    expect(stopped).toEqual(['worker-tmp-1']);
    expect(io.out).toContain('closed worker-tmp-1');
    expect(readFileSync(file, 'utf8')).not.toContain('tmp');
  });

  test('a seat that has not worked, or whose merge is not proved, is left', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = {
        stage: 'ready', temporary: { like: 'worker', until: 'result:done.md', own_commits: false },
      };
      session.seats['worker-tmp-2'] = {
        stage: 'ready', worked: true, temporary: { like: 'worker', until: 'merged:fix/fresh' },
      };
    });
    writeFileSync(join(dir, 'done.md'), 'done\n');
    const stopped: string[] = [];
    const io = testIo(dir);
    await runWatch(['--file', file, '--no-nudge'], io, sources({
      live: () => scene([agent('worker-tmp-1', 'idle'), agent('worker-tmp-2', 'idle')]),
      stopSeat: async (_session, seat) => { stopped.push(seat.name); return true; },
      readEnd: (_root, until) => until.startsWith('result:')
        ? { kind: 'result', exists: true }
        : { kind: 'merged', verdict: 'unproven', detail: 'the fetch failed; nothing is removed', ownNow: 0 },
    }));
    expect(stopped).toEqual([]);
    expect(io.out).toContain('fetch failed');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeDefined();
  });

  test('a merged worktree is removed only when an earlier pass saw commits of its own', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.worktrees.fresh = { path: 'work/fresh', branch: 'fix/fresh', own_commits: false, setup: 'ok' };
      session.worktrees.done = { path: 'work/done', branch: 'fix/done', own_commits: true, setup: 'ok' };
    });
    const removed: string[] = [];
    await runWatch(['--file', file, '--no-nudge'], testIo(dir), sources({
      readEnd: () => ({ kind: 'merged', verdict: 'merged', detail: 'its own commits are in the base', ownNow: 0 }),
      removeWorktree: (task) => { removed.push(task); return 0; },
    }));
    expect(removed).toEqual(['done']);
  });
});
