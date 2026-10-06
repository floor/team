import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notInForce } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import type { CallerSources, Process } from '../src/caller.ts';
import { ADD_DELEGATE_EDIT, DELEGATE_EXIT_IDS, delegateGate, logDelegated, type DelegateVerdict } from '../src/delegate.ts';
import { DELEGATE_COMMANDS, type DelegateCommand } from '../src/delegate-types.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { State } from '../src/state.ts';
import { LEGACY_LINE, type Standing } from '../src/store/store.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agent = (name: string | null, pane: string): HerdrAgent => ({
  name,
  agent: 'claude',
  pane,
  workspace: pane.split(':')[0] ?? '',
  status: 'idle',
  cwd: null,
});

const yaml = `format: 1
project: acme
session: alpha
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
delegates:
  - pane: other/w1:p1
    commands: [up, down, add, remove, approve]
`;

function parsed(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const base = parsed(yaml);

function verified(team: TeamFile, file: string): Standing {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: '2026-10-06T00:00:00.000Z',
    record: {
      approval: {
        format: 2,
        approvedAt: '2026-10-06T00:00:00.000Z',
        root: '/proj',
        fingerprints: fingerprints(team),
        ceilings: { seats: team.limits.seats, temporary: team.limits.temporary, vendors: { ...team.limits.vendors } },
      },
      file,
      generation: 1,
      signature: 'test',
    },
  };
}

const empty: State = { format: 1, sessions: {} };
const under: Process[] = [{ pid: 100, name: 'zsh' }, { pid: 10, name: 'herdr' }];
const terminal: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }];

type Scene = {
  command?: DelegateCommand;
  team?: TeamFile;
  file?: string;
  standing?: Standing;
  copy?: string | null;
  state?: State | null;
  stateError?: string;
  agents?: (session: string) => HerdrAgent[] | null;
  ancestors?: Process[] | null;
  roots?: Record<string, number | null>;
  stdinIsTTY?: boolean;
  flags?: readonly string[];
  callerSources?: (session: string | undefined) => CallerSources;
};

function gate(scene: Scene = {}): DelegateVerdict {
  const team = scene.team ?? base;
  const file = scene.file ?? yaml;
  const standing = scene.standing ?? verified(team, file);
  const ancestors = scene.ancestors === undefined ? under : scene.ancestors;
  const roots = scene.roots ?? { 'w1:p1': 100, 'w2:p1': 200, 'w3:p1': 300 };
  const agents = scene.agents ?? ((session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : []));
  const sources = scene.callerSources ?? ((session: string | undefined): CallerSources => ({
    ancestors: () => ancestors,
    agents: () => (session === undefined ? [] : agents(session)),
    paneRootPid: (pane) => (Object.hasOwn(roots, pane) ? roots[pane] ?? null : null),
    env: {},
    stdinIsTTY: scene.stdinIsTTY ?? true,
  }));
  return delegateGate({
    command: scene.command ?? 'up',
    team,
    root: '/proj',
    dir: '/proj/.agents',
    flags: scene.flags ?? [],
    io: { env: {}, stdinIsTTY: scene.stdinIsTTY ?? true },
    sources: {
      standing: () => standing,
      approvedCopy: () => (scene.copy === undefined ? file : scene.copy),
      state: () => {
        if (scene.stateError) throw new Error(scene.stateError);
        return scene.state === undefined ? empty : scene.state;
      },
      agents,
      callerSources: sources,
    },
  });
}

function refused(scene: Scene): { id: string; text: string } {
  const verdict = gate(scene);
  if (verdict.kind !== 'refused') throw new Error(`passed ${verdict.pane}`);
  return { id: verdict.id, text: verdict.text };
}

describe('the audit line and the edit refusal', () => {
  test('logLine writes the delegate line, and an add that would edit has its own refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-delegate-'));
    made.push(dir);
    logDelegated(dir, 'other/w1:p1', 'up', new Date('2026-10-06T12:00:00.000Z'));
    // A run of logDelegated on 2026-10-06 produced this line, the same bytes logLine writes.
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toBe('2026-10-06T12:00:00.000Z delegate [delegate] other/w1:p1 up\n');
    expect(ADD_DELEGATE_EDIT).toEqual({
      id: 'add.delegate-edit',
      text: 'the approved delegate cannot change the file or the approval; the owner adds a missing or stopped seat',
    });
  });
});

describe('a matching pane passes, and only that pane', () => {
  test('the approved pane passes, including a renamed agent and an allowed flag', () => {
    expect(gate()).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ agents: () => [agent('renamed', 'w1:p1')], flags: ['dry-run'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'down', flags: ['wait', 'dry-run'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'add', flags: ['dry-run', 'restore'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'remove' })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'approve' })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('another pane of the delegate session is refused, and so is a pane carrying the delegate agent\'s name', () => {
    const other = refused({
      agents: () => [agent('worker', 'w1:p1'), agent('assistant', 'w2:p1')],
      ancestors: [{ pid: 200, name: 'zsh' }, { pid: 10, name: 'herdr' }],
    });
    expect(other).toEqual({
      id: 'up.delegate',
      text: 'only the owner or the approved delegate runs `up`; this call is assistant',
    });
    const renamed = refused({
      agents: () => [agent('worker', 'w2:p1')],
      ancestors: [{ pid: 200, name: 'zsh' }, { pid: 10, name: 'herdr' }],
    });
    expect(renamed.id).toBe('up.delegate');
    expect(renamed.text).toContain('this call is worker');
  });

  test('the owner, a caller without a terminal, and an agent outside herdr are not the pane', () => {
    expect(refused({ ancestors: terminal }).text).toBe('only the owner or the approved delegate runs `up`; this call is owner');
    expect(refused({ ancestors: terminal, stdinIsTTY: false }).text).toContain('this call is unplaced (it doesn\'t run on a terminal)');
    const loose: Process[] = [{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }];
    expect(refused({ ancestors: loose }).text).toContain('this call is unplaced (it is run by an agent (claude) outside herdr)');
  });

  test('the second entry is the one that matches, and its own command list', () => {
    const text = yaml.replace(
      'commands: [up, down, add, remove, approve]',
      'commands: [add]\n  - pane: other/w2:p1\n    commands: [up, remove]',
    );
    const team = parsed(text);
    expect(gate({
      team,
      file: text,
      command: 'up',
      agents: () => [agent('worker', 'w1:p1'), agent('second', 'w2:p1')],
      ancestors: [{ pid: 200, name: 'zsh' }, { pid: 10, name: 'herdr' }],
    })).toEqual({ kind: 'passed', pane: 'other/w2:p1' });
    expect(refused({
      team,
      file: text,
      command: 'up',
      agents: () => [agent('worker', 'w1:p1'), agent('second', 'w2:p1')],
    }).text).toBe('the approved delegate other/w1:p1 may not run `up`; its approved commands are add');
  });
});

describe('refusal priority', () => {
  const drifted = {
    ...base,
    rules: ['a new rule'],
    seats: base.seats.map((seat, index) => (index === 0 ? { ...seat, model: 'Other' } : seat)),
  };

  test('each earlier refusal wins, and an unlisted command wins over a prohibited flag', () => {
    expect(refused({ standing: { kind: 'none' }, copy: null, team: drifted, stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-approval');
    expect(refused({ copy: null, team: drifted, stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-approved-copy');
    const approved = verified(base, yaml);
    expect(refused({ team: drifted, standing: approved, stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-drift');
    expect(refused({ stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-evidence');
    expect(refused({ team: { ...base, session: 'other' }, standing: approved, flags: ['session'] }).id).toBe('up.delegate-drift');
    const outside = { ...base, delegates: [{ pane: 'alpha/w9:p9', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team: outside, standing: verified(outside, yaml), ancestors: terminal }).id).toBe('up.delegate-placement');
    expect(refused({ ancestors: terminal, flags: ['session'] }).id).toBe('up.delegate');
    const listed = parsed(yaml.replace('commands: [up, down, add, remove, approve]', 'commands: [up]'));
    expect(refused({ command: 'down', team: listed, file: yaml.replace('commands: [up, down, add, remove, approve]', 'commands: [up]'), flags: ['abandon'] }).id).toBe('down.delegate-command');
    expect(refused({ flags: ['session'] }).id).toBe('up.delegate-flag');
  });

  test('no earlier copy, unverified approval, or unreadable evidence authorises', () => {
    const remembered: State = { format: 1, last_valid: { read_at: '2026-10-06T00:00:00.000Z', file: yaml }, sessions: {} };
    expect(refused({ standing: { kind: 'none' }, state: remembered }).id).toBe('up.delegate-approval');
    expect(refused({ standing: { kind: 'legacy' }, state: remembered }).id).toBe('up.delegate-approval');
    expect(refused({ standing: { kind: 'refused', why: 'the signing key cannot be read (EIO): restore it from a copy — no record verifies until it is back' } }).text).toBe(
      'delegation needs a verified approval: the signing key cannot be read (EIO): restore it from a copy — no record verifies until it is back',
    );
    expect(refused({ stateError: 'team.state.json is not valid JSON' }).text).toBe(
      'delegation cannot verify its placement or seats: team.state.json is not valid JSON',
    );
  });

  test('the standing text is notInForce, and drift names every difference', () => {
    expect(refused({ standing: { kind: 'none' } }).text).toBe(`delegation needs a verified approval: ${notInForce({ kind: 'none' })}`);
    expect(refused({ standing: { kind: 'legacy' } }).text).toContain(LEGACY_LINE);
    expect(refused({ copy: 'not a team file' }).text).toBe('delegation needs a readable approved copy: run `team approve`');
    expect(refused({ team: drifted, standing: verified(base, yaml) }).text).toBe(
      'delegation needs the approved file: the file is not the approved one (`rules` changed; seat lead changed): run `team approve`',
    );
  });
});

describe('placement', () => {
  test('the delegate session being the team session is refused, and so is a recorded or configured seat pane', () => {
    const recorded: State = { format: 1, sessions: { alpha: { seats: { lead: { stage: 'ready', pane: 'w4:p1' } }, worktrees: {} } } };
    const seated = { ...base, delegates: [{ pane: 'alpha/w4:p1', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team: seated, standing: verified(seated, yaml), state: recorded }).id).toBe('up.delegate-placement');
    const bare = { ...base, delegates: [{ pane: 'alpha/w9:p9', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team: bare, standing: verified(bare, yaml) }).id).toBe('up.delegate-placement');
    const configured = { ...base, delegates: [{ pane: 'alpha/w5:p1', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({
      team: configured,
      standing: verified(configured, yaml),
      agents: (session) => (session === 'alpha' ? [agent('lead', 'w5:p1')] : [agent('worker', 'w1:p1')]),
      roots: { 'w1:p1': 100, 'w5:p1': 500 },
    }).id).toBe('up.delegate-placement');
    expect(refused({ team: { ...base, session: 'other' }, command: 'approve' })).toEqual({
      id: 'approve.delegate-placement',
      text: 'the approved delegate must be an external non-seat pane',
    });
  });

  test('the same pane id in another session is not a seat of this team', () => {
    const recorded: State = { format: 1, sessions: { alpha: { seats: { lead: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} } } };
    expect(gate({ state: recorded })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('one colliding entry refuses the whole list', () => {
    const text = `${yaml}  - pane: alpha/w9:p9\n    commands: [up]\n`;
    expect(validateTeamFile(text).ok).toBe(false);
    const team = { ...base, delegates: [...(base.delegates ?? []), { pane: 'alpha/w9:p9', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team, standing: verified(team, yaml) }).id).toBe('up.delegate-placement');
  });

  test('unreadable ancestors or herdr are evidence, not a non-delegate', () => {
    expect(refused({ ancestors: null }).text).toBe(`delegation cannot verify its placement or seats: its parent processes can't be read to the top`);
    expect(refused({ ancestors: [] }).id).toBe('up.delegate-evidence');
    expect(refused({
      agents: () => null,
    }).text).toBe(`delegation cannot verify its placement or seats: it runs under herdr, and herdr doesn't answer`);
    expect(refused({ ancestors: terminal, agents: () => null }).text).toBe(`delegation cannot verify its placement or seats: herdr doesn't answer`);
    expect(refused({ roots: { 'w1:p1': null } }).text).toBe(`delegation cannot verify its placement or seats: it runs under herdr, and no pane root can be read`);
  });
});

describe('commands and flags', () => {
  const commands = ['up', 'down', 'add', 'remove'] as const;

  test('every preflight id of the four commands', () => {
    for (const command of commands) {
      expect(refused({ command, standing: { kind: 'none' } }).id).toBe(`${command}.delegate-approval`);
      expect(refused({ command, copy: null }).id).toBe(`${command}.delegate-approved-copy`);
      const drifted = { ...base, rules: ['changed'] };
      expect(refused({ command, team: drifted, standing: verified(base, yaml) }).id).toBe(`${command}.delegate-drift`);
      expect(refused({ command, state: null }).id).toBe(`${command}.delegate-evidence`);
      const inside = { ...base, delegates: [{ pane: 'alpha/w9:p9', commands: [command] }] };
      expect(refused({ command, team: inside, standing: verified(inside, yaml) }).id).toBe(`${command}.delegate-placement`);
    }
  });

  test('the non-delegate text, the unlisted command, and one prohibited flag of each command', () => {
    expect(refused({ command: 'down', ancestors: terminal }).text).toBe(
      'only the owner, the coordinator, the operator or the approved delegate stops the team; this call is owner',
    );
    expect(refused({ command: 'add', ancestors: terminal }).text).toBe(
      'only the owner, the coordinator, the operator or the approved delegate runs it; this call is owner',
    );
    expect(refused({ command: 'remove', ancestors: terminal }).text).toBe(
      'only the owner, the coordinator, the operator or the approved delegate runs it; this call is owner',
    );
    expect(refused({ command: 'approve', ancestors: terminal }).text).toBe(
      'only the owner or the approved delegate approves a team file; this call is owner',
    );
    for (const command of DELEGATE_COMMANDS) {
      const only = parsed(yaml.replace('commands: [up, down, add, remove, approve]', 'commands: [add]'));
      if (command === 'add') continue;
      const verdict = refused({ command, team: only, file: yaml.replace('commands: [up, down, add, remove, approve]', 'commands: [add]') });
      expect(verdict.id).toBe(`${command}.delegate-command`);
      expect(verdict.text).toBe(`the approved delegate other/w1:p1 may not run \`${command}\`; its approved commands are add`);
    }
    expect(refused({ command: 'up', flags: ['file', 'session'] }).text).toBe(`--session is the owner's; the approved delegate cannot use it`);
    expect(refused({ command: 'down', flags: ['abandon'] }).id).toBe('down.delegate-flag');
    expect(refused({ command: 'add', flags: ['temporary'] }).id).toBe('add.delegate-flag');
    expect(refused({ command: 'add', flags: ['like'] }).text).toContain('--like');
    expect(refused({ command: 'add', flags: ['until'] }).text).toContain('--until');
    expect(refused({ command: 'add', flags: ['worktree'] }).text).toContain('--worktree');
    expect(refused({ command: 'remove', flags: ['keep'] }).id).toBe('remove.delegate-flag');
    expect(refused({ command: 'remove', flags: ['abandon'] }).text).toContain('--abandon');
    expect(refused({ command: 'approve', flags: ['file'] }).id).toBe('approve.delegate-flag');
    expect(refused({ command: 'approve', flags: ['session', 'file'] }).text).toContain('--file');
  });
});

describe('approve cannot change delegates', () => {
  function live(commands: string): { team: TeamFile; file: string } {
    const file = yaml.replace('commands: [up, down, add, remove, approve]', `commands: [${commands}]`);
    return { team: parsed(file), file };
  }

  test('a change of pane, case, commands, order, or another entry is refused, and drift elsewhere is not', () => {
    const approved = live('approve, up');
    // The approved copy stays `approved.file`. Each live file differs in delegates only.
    for (const next of [live('up, approve'), live('approve'), live('approve, up, down')]) {
      expect(refused({ command: 'approve', team: next.team, file: approved.file, copy: approved.file, standing: verified(parsed(approved.file), approved.file) }).id).toBe('approve.delegate-section');
    }
    const cased = parsed(yaml.replace('other/w1:p1', 'Other/w1:p1').replace('commands: [up, down, add, remove, approve]', 'commands: [approve, up]'));
    expect(refused({ command: 'approve', team: cased, file: approved.file, copy: approved.file, standing: verified(parsed(approved.file), approved.file) }).text).toBe(
      'the approved delegate cannot approve a change to the delegate section; the owner approves this one',
    );
    const added = parsed(`${approved.file}  - pane: other/w2:p1\n    commands: [add]\n`);
    expect(refused({ command: 'approve', team: added, file: approved.file, copy: approved.file, standing: verified(parsed(approved.file), approved.file) }).id).toBe('approve.delegate-section');
    const without = parsed(yaml.replace('commands: [up, down, add, remove, approve]', 'commands: [approve]'));
    expect(refused({ command: 'approve', team: without, file: approved.file, copy: approved.file, standing: verified(parsed(approved.file), approved.file) }).id).toBe('approve.delegate-section');

    const rules = yaml.replace('session: alpha\n', 'session: alpha\nrules:\n  - a new rule\n');
    const ruled = parsed(rules);
    expect(gate({
      command: 'approve',
      team: ruled,
      file: yaml,
      copy: yaml,
      standing: verified(base, yaml),
    })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ team: ruled, standing: verified(base, yaml) }).id).toBe('up.delegate-drift');
  });
});

describe('the exit ids', () => {
  test('lists every delegate refusal, including the eight approve ids, and not a drift id for approve', () => {
    expect(DELEGATE_EXIT_IDS).toHaveLength(41);
    expect(DELEGATE_EXIT_IDS).toContain('approve.delegate-section');
    expect(DELEGATE_EXIT_IDS).not.toContain('approve.delegate-drift');
    for (const command of ['up', 'down', 'add', 'remove'] as const) {
      for (const suffix of ['delegate-approval', 'delegate-approved-copy', 'delegate-drift', 'delegate-evidence', 'delegate-placement', 'delegate', 'delegate-command', 'delegate-flag']) {
        expect(DELEGATE_EXIT_IDS).toContain(`${command}.${suffix}`);
      }
    }
    for (const suffix of ['delegate-approval', 'delegate-approved-copy', 'delegate-section', 'delegate-evidence', 'delegate-placement', 'delegate', 'delegate-command', 'delegate-flag']) {
      expect(DELEGATE_EXIT_IDS).toContain(`approve.${suffix}`);
    }
    expect(DELEGATE_EXIT_IDS).toContain('add.delegate-edit');
  });
});
