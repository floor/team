import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import type { Screen } from '../../src/watch/screen.ts';
import { testIo } from '../helpers.ts';

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  # stays above lead
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const owner = { kind: 'owner' as const };
const lead = { kind: 'seat' as const, name: 'lead', pane: 'w0:p1' };

let dir: string;
let file: string;
let clock: number;

function world(screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources;
  typed: string[];
  closed: string[];
  agents: HerdrAgent[];
  running: boolean[];
} {
  const typed: string[] = [];
  const closed: string[] = [];
  const agents: HerdrAgent[] = [];
  const running: boolean[] = [];
  clock = 0;
  const launch: DownLaunch = {
    typeText: (_session, _pane, text) => { typed.push(text); return true; },
    pressEnter: () => true,
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    kill: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const sources: RemoveSources = {
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    status: () => status,
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    launch,
    foreground: () => (running[0] === false ? [] : ['claude']),
  };
  return { sources, typed, closed, agents, running };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-remove-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, FILE);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('team remove', () => {
  test('a free seat is exited, then taken out, and the comment above the next seat stays', async () => {
    const made = world();
    made.running.push(false);
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual(['w1']);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('name: worker');
    expect(text).toContain('# stays above lead');
    expect(text).toContain('name: lead');
  });

  test('a seat that is not running is taken out without typing', async () => {
    const made = world();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('--keep leaves the seat stopped', async () => {
    const made = world();
    expect(await runRemove(['worker', '--keep', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('name: worker');
    expect(text).toContain('stopped: true');
    expect(text).toContain('name: lead');
  });

  test('working, blocked, unknown and unsent change nothing', async () => {
    for (const [status, screen, phrase] of [
      ['working', { kind: 'idle' }, 'is working'],
      ['idle', { kind: 'permission' }, 'is blocked'],
      ['idle', { kind: 'unknown' }, 'does not recognise'],
      ['idle', { kind: 'unsent' }, 'unsent'],
    ] as const) {
      writeFileSync(file, FILE);
      const made = world(screen, status);
      made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null });
      const io = testIo(dir, owner);
      expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
      expect(io.err).toContain(phrase);
      expect(made.typed).toEqual([]);
      expect(readFileSync(file, 'utf8')).toContain('name: worker');
    }
  });

  test('a time-out leaves the seat and the file', async () => {
    const made = world();
    made.running.push(true);
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.out).toContain('left as it is');
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('only the owner removes the coordinator, and only the owner abandons', async () => {
    const made = world();
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const seat = testIo(dir, lead);
    expect(await runRemove(['lead'], seat, made.sources)).toBe(1);
    expect(seat.err).toContain('only the owner');
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
    const abandon = testIo(dir, lead);
    expect(await runRemove(['worker', '--abandon'], abandon, world({ kind: 'permission' }, 'idle').sources)).toBe(1);
    expect(abandon.err).toContain('only the owner abandons');
  });

  test('--abandon closes a blocked seat without typing, and the owner may remove the coordinator', async () => {
    const made = world({ kind: 'permission' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    expect(await runRemove(['worker', '--abandon', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    const leadRun = world();
    leadRun.running.push(false);
    leadRun.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    expect(await runRemove(['lead', '--file', file], testIo(dir, owner), leadRun.sources)).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('name: lead');
  });

  test('a temporary seat is stopped and not written into the file', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:done.md' } };
    });
    const made = world();
    made.running.push(false);
    made.agents.push({ name: 'worker-tmp-1', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null });
    expect(await runRemove(['worker-tmp-1', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('tmp');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeUndefined();
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:done.md' } };
    });
    const kept = testIo(dir, owner);
    expect(await runRemove(['worker-tmp-1', '--keep', '--file', file], kept, world().sources)).toBe(1);
    expect(kept.err).toContain('nothing to keep');
  });

  test('a caller who may not change the team changes nothing', async () => {
    const io = testIo(dir, { kind: 'seat', name: 'worker', pane: 'w1:p1' });
    expect(await runRemove(['worker'], io, world().sources)).toBe(1);
    expect(io.err).toContain('only the owner, the coordinator or the operator');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });
});
