import { describe, expect, test } from 'bun:test';
import { mayChangeTeam, placeCaller, readAncestors } from '../src/caller.ts';
import type { CallerSources, Process } from '../src/caller.ts';
import type { HerdrAgent } from '../src/herdr.ts';

const agent = (name: string | null, pane: string): HerdrAgent => ({ name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? '', status: 'idle', cwd: null });

function sources(ancestors: Process[], over: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => ancestors,
    agents: () => [agent('claude-coordinator', 'w1:p1'), agent('codex-acme', 'w2:p1'), agent(null, 'w3:p1')],
    paneRootPid: (pane) => ({ 'w1:p1': 100, 'w2:p1': 200, 'w3:p1': 300 })[pane] ?? null,
    env: {},
    stdinIsTTY: true,
    ...over,
  };
}

const terminal: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }, { pid: 30, name: 'Terminal' }];
const seat: Process[] = [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'codex' }, { pid: 10, name: 'herdr' }];

describe('the caller is placed by its parent processes', () => {
  test('a terminal outside herdr, with no agent above it, is the owner', () => {
    expect(placeCaller(sources(terminal))).toEqual({ kind: 'owner' });
  });

  test('a command run by an agent in a herdr pane is that seat', () => {
    expect(placeCaller(sources(seat))).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'w2:p1' });
  });

  test('a herdr pane without an agent is neither the owner nor a seat', () => {
    const plain: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    expect(placeCaller(sources(plain))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/pane without an agent/) });
  });

  test('an agent whose pane has no herdr name can\'t be placed', () => {
    const unnamed: Process[] = [{ pid: 300, name: 'claude' }, { pid: 10, name: 'herdr' }];
    expect(placeCaller(sources(unnamed))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/no herdr name/) });
  });

  test('an agent outside herdr is not the owner', () => {
    const loose: Process[] = [{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }, { pid: 40, name: 'zsh' }];
    expect(placeCaller(sources(loose))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/agent \(claude\)/) });
  });

  test('unsetting variables never makes an owner: the processes decide', () => {
    expect(placeCaller(sources(seat, { env: {} })).kind).toBe('seat');
  });

  test('a pane named in HERDR_PANE_ID is not believed without its process', () => {
    expect(placeCaller(sources(seat, { env: { HERDR_PANE_ID: 'w1:p1' } }))).toEqual({ kind: 'seat', name: 'codex-acme', pane: 'w2:p1' });
  });

  test('AGENT_UNATTENDED only ever adds a refusal', () => {
    expect(placeCaller(sources(terminal, { env: { AGENT_UNATTENDED: '1' } })).kind).toBe('unplaced');
  });

  test('a call that is not on a terminal is not the owner\'s', () => {
    expect(placeCaller(sources(terminal, { stdinIsTTY: false })).kind).toBe('unplaced');
  });

  test('under herdr, a herdr that doesn\'t answer places nobody', () => {
    expect(placeCaller(sources(seat, { agents: () => null })).kind).toBe('unplaced');
  });

  test('unreadable parents place nobody', () => {
    expect(placeCaller(sources([])).kind).toBe('unplaced');
  });
});

describe('who may change a running team', () => {
  const team = { coordinator: 'claude-coordinator', operator: 'claude-operator' };
  test('the owner, the coordinator and the operator', () => {
    expect(mayChangeTeam({ kind: 'owner' }, team)).toBe(true);
    expect(mayChangeTeam({ kind: 'seat', name: 'claude-coordinator', pane: 'w1:p1' }, team)).toBe(true);
    expect(mayChangeTeam({ kind: 'seat', name: 'claude-operator', pane: 'w4:p1' }, team)).toBe(true);
  });
  test('no other seat, and no unplaced caller', () => {
    expect(mayChangeTeam({ kind: 'seat', name: 'codex-acme', pane: 'w2:p1' }, team)).toBe(false);
    expect(mayChangeTeam({ kind: 'unplaced', reason: 'x' }, team)).toBe(false);
  });
});

describe('reading the real process table', () => {
  test('the test runner\'s parents are read by name, nearest first', () => {
    const ancestors = readAncestors(process.pid);
    expect(ancestors[0]?.pid).toBe(process.pid);
    expect(ancestors.length).toBeGreaterThan(1);
    for (const one of ancestors) expect(one.name).not.toContain('/');
  });
});
