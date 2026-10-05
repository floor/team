// Who may change a running team: the owner, or the coordinator's / operator's seat of the
// session the team file names, on the pane the state records for it. A seat of another session
// is a seat of that session — a pane merely renamed to the coordinator's name, even in the right
// session, is not the coordinator's — and a caller of the right session on the pane the state
// records behaves exactly as it did before the session and the pane were judged.
//
// The callers are placed the way the caller tests place them, through fake sources, and handed
// to each command's real run function, so the gate under test is the shipped one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { placeCaller, type Caller, type CallerSources } from '../../src/caller.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../../src/commands/answer.ts';
import { runDown, type DownSources } from '../../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo, type TestIo } from '../helpers.ts';

const SESSION = 'acme-web';
const OTHER = 'other-web';
const COORDINATOR = 'claude-coordinator-acme';
const OPERATOR = 'claude-operator-acme';
const SEAT = 'codex-acme';
const COORDINATOR_PANE = 'w1:p1';

const FILE = `format: 1
project: acme
session: ${SESSION}
coordinator: ${COORDINATOR}
operator: ${OPERATOR}
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: ${COORDINATOR}
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: ${OPERATOR}
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: ${SEAT}
    label: codex
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;

const STATE = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: {
        [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE },
        [OPERATOR]: { stage: 'ready', pane: 'w4:p1' },
        [SEAT]: { stage: 'ready', pane: 'w3:p1' },
      },
      worktrees: {},
    },
  },
};

// The same state, with the implementer's seat temporary: it changes nothing about who may
// change the team.
const TEMPORARY_STATE = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: { [SEAT]: { stage: 'ready', pane: 'w3:p1', temporary: { like: COORDINATOR, until: '2026-10-06T00:00:00Z' } } },
      worktrees: {},
    },
  },
};

let dir: string;
let file: string;
let stateFile: string;
let home: string;
let emptyHome: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-coordinator-session-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  stateFile = join(dir, '.agents', 'team.state.json');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(file, FILE);
  // The approval in force `remove` needs to stop a seat and edit the file, signed over the
  // file above. `emptyHome` is a store that was never written: refusals for the commands
  // that need no approval in force.
  home = join(dir, 'home');
  emptyHome = join(dir, 'home-empty');
  const loaded = loadTeamFile(dir);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: FILE },
    loaded.team.seats,
    home,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A caller placed by fake sources: its parent chain holds pane `pane`'s root process, and the
// session's agent list holds the pane under `name`. `session` is the session the placement is
// made in — the whole point of the cases below.
function placed(session: string | undefined, name: string | null, pane: string): Caller {
  const row: HerdrAgent = { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? '', status: 'idle', cwd: null };
  const sources: CallerSources = {
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => [row],
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  };
  return session === undefined ? placeCaller(sources) : placeCaller(sources, session);
}

type Run = { code: number; out: string; err: string; before: string; beforeState: string };

// Every run starts from the file and the state as written: the same caller can be run twice
// against the same world, and a refusal can be checked against the bytes it started from.
async function call(
  runner: (io: TestIo) => Promise<number>,
  caller: Caller,
  options: { state?: Record<string, unknown> | null } = {},
): Promise<Run> {
  writeFileSync(file, FILE);
  const state = options.state === undefined ? (STATE as Record<string, unknown>) : options.state;
  if (state === null) rmSync(stateFile, { force: true });
  else writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');
  const beforeState = state === null ? '' : readFileSync(stateFile, 'utf8');
  const io = testIo(dir, caller);
  const code = await runner(io);
  return { code, out: io.out, err: io.err, before, beforeState };
}

function addSources(): AddSources {
  return {
    home: emptyHome,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: {} as DoctorSources,
    now: () => new Date(0),
    launch: {} as Launch,
  };
}

function removeSources(over: Partial<RemoveSources> = {}): RemoveSources {
  return {
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => [],
    now: () => new Date(0),
    ...over,
  };
}

function worktreeSources(over: Partial<WorktreeSources> = {}): WorktreeSources {
  return { home: emptyHome, now: () => new Date(0), ...over };
}

function downSources(over: Partial<DownSources> = {}): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => [],
    now: () => new Date(0),
    ...over,
  };
}

function answerHost(): AnswerHost {
  return {
    version: () => null,
    agents: () => [],
    pane: () => undefined,
    sendKey: () => false,
    rename: () => false,
    foreground: () => [],
    foregroundCwd: () => null,
    list: () => [],
    status: () => null,
    type: () => false,
    enter: () => false,
    now: () => new Date(0),
    sleep: async () => {},
    home: emptyHome,
    standing: () => ({ kind: 'none' }),
  };
}

const NEVER_APPROVED = 'the file was never approved on this machine: run `team approve`';

type Case = {
  name: string;
  run: (caller: Caller, options?: { state?: Record<string, unknown> | null }) => Promise<Run>;
  // The refusal a caller that is not this team's sees, with the caller named as main named it.
  refusal: (who: string) => string;
  // The owner's run: what the gate lets through, when nothing else refuses.
  owner: string;
};

const COMMANDS: Case[] = [
  {
    name: 'add',
    run: (caller, options) => call((io) => runAdd(['probe-seat'], io, addSources()), caller, options),
    refusal: (who) => `team add: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    owner: `team add: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'remove',
    run: (caller, options) => call((io) => runRemove([SEAT], io, removeSources()), caller, options),
    refusal: (who) => `team remove: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    owner: '',
  },
  {
    name: 'worktree new',
    run: (caller, options) => call((io) => runWorktree(['new', 'probe-task'], io, worktreeSources()), caller, options),
    refusal: (who) => `team worktree: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'worktree remove',
    run: (caller, options) => call((io) => runWorktree(['remove', 'probe-task'], io, worktreeSources()), caller, options),
    refusal: (who) => `team worktree: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'down',
    run: (caller, options) => call((io) => runDown([], io, downSources()), caller, options),
    refusal: (who) => `team down: only the owner, the coordinator or the operator stops the team; this call is ${who}\n`,
    owner: 'team down: this call has no way to reach herdr\n',
  },
  {
    name: 'answer',
    run: (caller, options) => call((io) => runAnswer([SEAT, 'trust'], io, answerHost()), caller, options),
    refusal: () => `${SEAT}: only the owner, or the coordinator from its own seat, can answer\n`,
    owner: `${NEVER_APPROVED}\n`,
  },
];

for (const command of COMMANDS) {
  describe(`${command.name}: who may change the team`, () => {
    test('a seat of another session is refused, named as its own session placed it', async () => {
      const run = await command.run(placed(OTHER, COORDINATOR, COORDINATOR_PANE));
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the operator of another session is refused the same way', async () => {
      const run = await command.run(placed(OTHER, OPERATOR, 'w4:p1'));
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(OPERATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a pane merely renamed, in the team\'s own session, is refused: the state records another pane', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, 'w9:p1'));
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the coordinator on its recorded pane is read exactly as main read it', async () => {
      const judged = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE));
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    test('a state that records no pane leaves the caller of this session as main read it', async () => {
      const judged = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), { state: null });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE }, { state: null });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    test('a temporary seat is no coordinator', async () => {
      const run = await command.run(placed(SESSION, SEAT, 'w3:p1'), { state: TEMPORARY_STATE });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.refusal(SEAT) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a pane without an agent is no coordinator', async () => {
      const run = await command.run(placed(SESSION, null, 'w7:p1'));
      expect(run.code).toBe(1);
      expect(run.err).toContain('it runs in pane w7:p1, whose agent has no herdr name');
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the owner is read as main read it', async () => {
      const run = await command.run({ kind: 'owner' });
      if (command.name === 'remove') {
        // The store holds an approval in force for this caller: the owner's removal runs.
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 0, out: `removed ${SEAT}\n`, err: '' });
        return;
      }
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.owner });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });
  });
}

// The reported run, as a regression: a pane in another herdr session, renamed to the
// coordinator's name, running `team remove codex-acme`. It removes nothing, stops nothing and
// leaves both the file and the state byte-identical.
describe('the renamed pane in another session', () => {
  test('remove leaves the team file byte-identical and exits 1', async () => {
    const run = await call((io) => runRemove([SEAT], io, removeSources()), placed(OTHER, COORDINATOR, COORDINATOR_PANE));
    expect(run.code).toBe(1);
    expect(run.out).toBe('');
    expect(run.err).toBe(`team remove: only the owner, the coordinator or the operator runs it; this call is ${COORDINATOR}\n`);
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });
});

// remove stops a seat and edits the file: without an approval in force it does neither, in the
// words every command uses for the case.
describe('remove needs an approval in force', () => {
  const CASES: { name: string; sources: () => RemoveSources; why: string }[] = [
    { name: 'never approved', sources: () => removeSources({ home: emptyHome }), why: `team remove: ${NEVER_APPROVED}\n` },
    {
      name: 'a legacy record',
      sources: () => removeSources({ standing: () => ({ kind: 'legacy' }) }),
      why: 'team remove: approved before records were signed: run `team approve` once\n',
    },
    {
      name: 'a record the verification refused',
      sources: () => removeSources({ standing: () => ({ kind: 'refused', why: 'the record does not carry a valid signature' }) }),
      why: 'team remove: the record does not carry a valid signature\n',
    },
  ];

  for (const one of CASES) {
    test(`${one.name}: refused, with the file and the state untouched`, async () => {
      const run = await call((io) => runRemove([SEAT], io, one.sources()), { kind: 'owner' });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: one.why });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
      expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    });
  }
});
