import { describe, expect, test } from 'bun:test';
import { mayChangeTeam, parseStat, placeCaller, processReader, readAncestors, readWithProc, readWithPs } from '../src/caller.ts';
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

  test('a walk that stopped before the top places nobody, even on a terminal', () => {
    expect(placeCaller(sources(terminal, { ancestors: () => null }))).toMatchObject({ kind: 'unplaced', reason: expect.stringMatching(/to the top/) });
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

describe('reading the process table', () => {
  test('the test runner\'s parents are read by name, nearest first, to the top', () => {
    const ancestors = readAncestors(process.pid);
    if (!ancestors) throw new Error('the walk did not reach the top');
    expect(ancestors[0]?.pid).toBe(process.pid);
    expect(ancestors.length).toBeGreaterThan(1);
    for (const one of ancestors) expect(one.name).not.toContain('/');
  });

  const table: Record<number, { ppid: number; name: string }> = {
    210: { ppid: 200, name: 'zsh' },
    200: { ppid: 10, name: 'claude' },
    10: { ppid: 1, name: 'herdr' },
  };

  test('a complete walk ends at the system\'s first process', () => {
    expect(readAncestors(210, (pid) => table[pid] ?? null)?.map((one) => one.name)).toEqual(['zsh', 'claude', 'herdr']);
  });

  test('a process that can\'t be read makes the walk incomplete, not shorter', () => {
    // Cut below the herdr server: a shorter list would look like a plain terminal.
    expect(readAncestors(210, (pid) => (pid === 10 ? null : table[pid] ?? null))).toBeNull();
  });

  test('a chain that never ends is incomplete', () => {
    expect(readAncestors(5, () => ({ ppid: 5, name: 'loop' }))).toBeNull();
  });

  // A captured /proc tree, as Linux writes one: the same ancestors the table above names.
  const linuxProc = new URL('./fixtures/linux/proc', import.meta.url).pathname;

  test('Linux walks /proc and answers what the table above answers', () => {
    expect(readAncestors(210, (pid) => readWithProc(pid, linuxProc))).toEqual([
      { pid: 210, name: 'zsh' },
      { pid: 200, name: 'claude' },
      { pid: 10, name: 'herdr' },
    ]);
  });

  test('a line of /proc/<pid>/stat: the name may hold a space or a parenthesis', () => {
    const line = '210 (zsh) S 200 210 210 34816 210 4194304 1185 0 0 0 12 5 0 0 20 0 1 0 1234567 12345678 1234 18446744073709551615 0 0 0';
    expect(parseStat(line)).toEqual({ ppid: 200, name: 'zsh' });
    // The last parenthesis closes the name, whatever the name holds.
    expect(parseStat(line.replace('(zsh)', '(tmux: server (2))'))).toEqual({ ppid: 200, name: 'tmux: server (2)' });
  });

  test('a line of /proc that holds no parent places nobody, and so does one that can\'t be read', () => {
    expect(parseStat('')).toBeNull();
    expect(parseStat('210 (zsh) S')).toBeNull();
    expect(parseStat('nonsense')).toBeNull();
    expect(readWithProc(999_999, linuxProc)).toBeNull();
  });

  test('the platform picks the table: /proc on Linux, ps everywhere else', () => {
    expect(processReader('linux')).toBe(readWithProc);
    expect(processReader('darwin')).toBe(readWithPs);
  });
});
