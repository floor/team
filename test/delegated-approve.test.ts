// The delegated `approve` and its self-escalation guard: the non-negotiable gate of this
// change. A delegate approves ordinary changes freely — the roster, launch lines, rules — and
// can never approve a sovereign one: `delegates`, `budgets`, `limits`, identity, `trust`.
// Here the guard is the real one: gate-level scenes against `delegateGate` with only the
// reads a scratch test cannot make faked (the standing, the approved copy, herdr, the state,
// the placement), and end-to-end runs of `runApprove` over a real signed store in a scratch
// home — the real guard, the real key, the real log line.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferencesOf, approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import type { Caller, CallerSources, Process } from '../src/caller.ts';
import { runApprove, type ApproveSources } from '../src/commands/approve.ts';
import { SOVEREIGN_SECTIONS, delegateGate, type DelegateSources, type DelegateVerdict } from '../src/delegate.ts';
import type { DelegateCommand } from '../src/delegate-types.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { State } from '../src/state.ts';
import { approvalStanding, readApproval, storePath, writeApproval, type Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

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

// A real directory for the trust entry: the loader reads the disk for a trust path.
const land = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegated-approve-')));
made.push(land);

const yaml = `format: 1
project: acme
session: alpha
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ${land}
rules:
  - Keep every change on a branch.
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
    commands: [up, approve]
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
  agents?: (session: string) => HerdrAgent[] | null;
  ancestors?: Process[] | null;
  roots?: Record<string, number | null>;
  flags?: readonly string[];
  callerSources?: (session: string | undefined) => CallerSources;
};

function gate(scene: Scene = {}): DelegateVerdict {
  const team = scene.team ?? base;
  const file = scene.file ?? yaml;
  // The approved file is `base`; a scene's `team` is a candidate against it. Scenes that
  // approve of a different file pass their own standing, as delegate.test.ts does.
  const standing = scene.standing ?? verified(base, yaml);
  const ancestors = scene.ancestors === undefined ? under : scene.ancestors;
  const roots = scene.roots ?? { 'w1:p1': 100, 'w2:p1': 200, 'w3:p1': 300 };
  const agents = scene.agents ?? ((session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : []));
  const sources = scene.callerSources ?? ((session: string | undefined): CallerSources => ({
    ancestors: () => ancestors,
    agents: () => (session === undefined ? [] : agents(session)),
    paneRootPid: (pane) => (Object.hasOwn(roots, pane) ? roots[pane] ?? null : null),
    env: {},
    stdinIsTTY: true,
  }));
  return delegateGate({
    command: scene.command ?? 'approve',
    team,
    root: '/proj',
    dir: '/proj/.agents',
    flags: scene.flags ?? [],
    io: { env: {}, stdinIsTTY: true },
    sources: {
      standing: () => standing,
      approvedCopy: () => (scene.copy === undefined ? file : scene.copy),
      state: () => (scene.state === undefined ? empty : scene.state),
      agents,
      sessionRunning: () => null,
      callerSources: sources,
    },
  });
}

function refused(scene: Scene): Extract<DelegateVerdict, { kind: 'refused' }> {
  const verdict = gate(scene);
  if (verdict.kind !== 'refused') throw new Error(`passed ${verdict.pane}`);
  return verdict;
}

describe('the sovereign guard', () => {
  test('the sovereign set is exactly the five, pinned', () => {
    expect(SOVEREIGN_SECTIONS).toEqual(['budgets', 'delegates', 'identity', 'limits', 'trust']);
  });

  // One candidate per sovereign section, each a single real edit away from the approved file.
  const sovereign: [section: string, team: TeamFile][] = [
    ['delegates', { ...base, delegates: [{ pane: 'other/w1:p1', commands: ['up', 'approve', 'down'] }] }],
    ['delegates', { ...base, delegates: [{ pane: 'other/w1:p1', commands: ['approve', 'up'] }] }],
    ['budgets', { ...base, budgets: { ...base.budgets, checkEvery: base.budgets.checkEvery + 60 } }],
    ['limits', { ...base, limits: { ...base.limits, seats: base.limits.seats + 1 } }],
    ['identity', { ...base, identity: { ...base.identity, humans: [...base.identity.humans, 'someone'] } }],
    ['trust', { ...base, trust: [...base.trust, '/usr'] }],
  ];

  test('a delegate cannot approve any of them: refused by name, "this change needs the owner"', () => {
    for (const [section, team] of sovereign) {
      expect(refused({ team })).toEqual({
        kind: 'refused',
        id: 'approve.delegate-sovereign',
        text: `this change needs the owner: \`${section}\` changed`,
      });
      // The guard is the difference step: it decides before the evidence walk is read and
      // before the flags are looked at, which is what fail-closed means for this step.
      expect(refused({ team, state: null }).id).toBe('approve.delegate-sovereign');
      expect(refused({ team, flags: ['file'] }).id).toBe('approve.delegate-sovereign');
    }
  });

  test('the reordering of an unchanged grant is a sovereign change too: the whole value is the grant', () => {
    const reordered = parsed(yaml.replace('commands: [up, approve]', 'commands: [approve, up]'));
    expect(refused({ team: reordered, standing: verified(base, yaml) }).text).toBe('this change needs the owner: `delegates` changed');
  });

  test('the earlier steps still win: an unverified approval, an unreadable copy, before the guard', () => {
    const candidate = sovereign[0]![1];
    expect(refused({ team: candidate, standing: { kind: 'none' } }).id).toBe('approve.delegate-approval');
    expect(refused({ team: candidate, copy: null, standing: verified(base, yaml) }).id).toBe('approve.delegate-approved-copy');
  });
});

describe('an ordinary change passes, and only an ordinary one', () => {
  const second = { ...base.seats[0]!, name: 'worker', label: 'worker' };
  const ordinary: [name: string, team: TeamFile][] = [
    ['a rules edit', { ...base, rules: [...base.rules, 'Sign every commit.'] }],
    ['a launch line', { ...base, seats: base.seats.map((seat) => ({ ...seat, launch: `${seat.launch} --verbose` })) }],
    ['a roster edit', { ...base, seats: [...base.seats, second] }],
  ];

  test('rules, a launch line and the roster: the approved pane passes', () => {
    for (const [, team] of ordinary) {
      expect(gate({ team })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    }
    // All at once, trust untouched: still the delegate's to approve.
    const together = { ...base, rules: [...base.rules, 'Sign every commit.'], seats: base.seats.map((seat) => ({ ...seat, model: 'Other' })) };
    expect(gate({ team: together })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('an ordinary difference is not a licence: every later step still refuses what it always did', () => {
    const ordinaryTeam = ordinary[0]![1];
    expect(refused({ team: ordinaryTeam, state: null }).id).toBe('approve.delegate-evidence');
    expect(refused({ team: ordinaryTeam, flags: ['file'] }).id).toBe('approve.delegate-flag');
    expect(refused({ team: ordinaryTeam, ancestors: terminal })).toEqual({
      kind: 'refused',
      id: 'approve.delegate',
      text: 'only the owner or the approved delegate approves a team file; this call is owner',
    });
  });

  test('the delegated grant\'s own flags: a delegate cannot choose the file, and --show and --confirm are not the owner\'s to withhold', () => {
    expect(refused({ flags: ['file'] })).toEqual({
      kind: 'refused',
      id: 'approve.delegate-flag',
      text: "--file is the owner's; the approved delegate cannot use it",
    });
    // `--show` returns before the gate in the command, and `--confirm` is inert on the
    // delegated path; neither is a refusal of the gate's.
    expect(gate({ flags: ['show', 'confirm'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });
});

// The end-to-end runs: a real signed store in a scratch home, the real gate, the real key —
// only herdr and the state are stood in for, because no scratch test has a live team session.
const T = new Date('2026-10-07T12:00:00.000Z');
const TEXT = `format: 1
project: acme
session: acme-web
operator: lead
workspace:
  mode: shared
rules:
  - Keep every change on a branch.
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
delegates:
  - pane: other/w1:p1
    commands: [approve]
`;

type Place = { base: string; home: string; root: string; file: string };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-approve-run-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  return { base, home, root, file: join(root, '.agents', 'team.yaml') };
}

function checkedOf(place: Place, text: string): TeamFile {
  const checked = validateTeamFile(text, { home: place.home, root: place.root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.team;
}

/** The store as an owner's approval leaves it: the file written, the record really signed. */
function approvedPlace(place: Place, text: string): TeamFile {
  const team = checkedOf(place, text);
  writeFileSync(place.file, text);
  writeApproval(storePath(team.project, place.root, place.home), { approval: approvalOf(team, place.root, T), file: text }, team.seats, place.home);
  return team;
}

const DELEGATE: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p1', session: 'other' };
const STRANGER: Caller = { kind: 'seat', name: 'pilot', pane: 'w9:p9' };

const faked: DelegateSources = {
  state: () => ({ format: 1, sessions: {} }),
  agents: () => [],
};

function connected(place: Place, over: Partial<ApproveSources> = {}): ApproveSources {
  return { ask: async () => '1', waiting: () => 'empty', now: () => T, home: place.home, delegate: faked, ...over };
}

const neverAsked = () => async (): Promise<string | null> => {
  throw new Error('the delegated path asked a question');
};
const neverRead = (): never => {
  throw new Error('the delegated path read the terminal');
};

async function approveRun(place: Place, argv: string[], caller: Caller, sources: ApproveSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(place.root, caller);
  return { code: await runApprove(argv, io, sources), out: io.out, err: io.err };
}

function storeOf(place: Place, text: string): string {
  return storePath(checkedOf(place, text).project, place.root, place.home);
}

describe('the delegated approval end to end', () => {
  test('an ordinary change: the delegate approves, the record seals it, and the audit line names what it sealed', async () => {
    const placeOne = place();
    approvedPlace(placeOne, TEXT);
    const candidate = TEXT.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(placeOne.file, candidate);
    const store = storeOf(placeOne, candidate);

    const run = await approveRun(placeOne, [], DELEGATE, connected(placeOne, { ask: neverAsked(), waiting: neverRead }));
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toContain('Approved.');
    // The audit line: who (the pane), which act, what changed. Nothing else wrote here.
    const log = join(placeOne.root, '.agents', 'team.log');
    expect(readFileSync(log, 'utf8')).toBe(`${T.toISOString()} delegate [delegate] other/w1:p1 approve: \`rules\` changed\n`);

    // The record really is on the candidate: the standing verifies and nothing differs.
    const standing = approvalStanding(placeOne.root, placeOne.home);
    expect(standing.kind).toBe('verified');
    if (standing.kind !== 'verified') throw new Error('not verified');
    expect(approvalDifferencesOf(standing, checkedOf(placeOne, candidate))).toEqual([]);
    expect(readApproval(store)?.file).toBe(candidate);
  });

  test('a sovereign change: refused with the owner\'s sentence, nothing signed, no log line', async () => {
    const placeOne = place();
    approvedPlace(placeOne, TEXT);
    // The trust list widened with a real folder, and a file that still loads: a migrated trust
    // file must list the lobby and cover every seat's cwd, so the candidate adds both. The one
    // difference from the approved copy is the trust list, and the guard must catch it before
    // any of the walk.
    const candidate = `${TEXT}trust:\n  - ${join(placeOne.home, '.config', 'team', 'lobby')}\n  - ${placeOne.root}\n`;
    writeFileSync(placeOne.file, candidate);
    const store = storeOf(placeOne, candidate);
    const before = readApproval(store);

    const run = await approveRun(placeOne, [], DELEGATE, connected(placeOne, { ask: neverAsked(), waiting: neverRead }));
    expect(run.code).toBe(1);
    expect(run.err).toBe('team approve: this change needs the owner: `trust` changed\n');
    expect(readApproval(store)).toEqual(before);
    const log = join(placeOne.root, '.agents', 'team.log');
    expect(existsSync(log)).toBe(false);
    const standing = approvalStanding(placeOne.root, placeOne.home);
    expect(standing.kind).toBe('verified');
    if (standing.kind !== 'verified') throw new Error('not verified');
    expect(approvalDifferencesOf(standing, checkedOf(placeOne, candidate))).toEqual(['`trust` changed']);
  });

  test('the owner approves a sovereign change — the widened grant itself — and no gate is consulted', async () => {
    const placeOne = place();
    approvedPlace(placeOne, TEXT);
    const candidate = TEXT.replace('    commands: [approve]\n', '    commands: [approve, up]\n');
    writeFileSync(placeOne.file, candidate);

    const run = await approveRun(placeOne, [], { kind: 'owner' }, connected(placeOne, {
      gate: () => {
        throw new Error('the gate was asked for the owner');
      },
    }));
    expect(run.code).toBe(0);
    expect(run.out).toContain('Approved.');
    const standing = approvalStanding(placeOne.root, placeOne.home);
    if (standing.kind !== 'verified') throw new Error('not verified');
    expect(approvalDifferencesOf(standing, checkedOf(placeOne, candidate))).toEqual([]);
  });

  test('a caller who is not the approved pane is refused, and nothing is written', async () => {
    const placeOne = place();
    approvedPlace(placeOne, TEXT);
    const candidate = TEXT.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(placeOne.file, candidate);
    const store = storeOf(placeOne, candidate);
    const before = readApproval(store);

    const run = await approveRun(placeOne, [], STRANGER, connected(placeOne));
    expect(run.code).toBe(1);
    expect(run.err).toBe('team approve: only the owner or the approved delegate approves a team file; this call is pilot\n');
    expect(readApproval(store)).toEqual(before);
  });

  test('a delegate cannot choose the file: --file is refused by the gate', async () => {
    const placeOne = place();
    approvedPlace(placeOne, TEXT);
    const run = await approveRun(placeOne, ['--file', placeOne.file], DELEGATE, connected(placeOne));
    expect(run.code).toBe(1);
    expect(run.err).toBe("team approve: --file is the owner's; the approved delegate cannot use it\n");
  });
});
