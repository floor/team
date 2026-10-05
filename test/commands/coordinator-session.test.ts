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
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
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

// The state tag v0.2.1 (4e0e311) writes, byte for byte: built by replaying its own
// `src/launch/execute.ts` patches through its own `readState`/`updateState`
// (coordinator-session.scratch/build-021-state.ts), so the field names and the extra `cli`
// and `rules` records are the release's, not a guess. It records the coordinator's pane —
// this is the state every upgrading team has.
const STATE_021 = {
  format: 1,
  sessions: {
    [SESSION]: {
      seats: {
        [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE, workspace: 'w1', cli: 'claude-code', rules: 'option' },
        [OPERATOR]: { stage: 'ready', pane: 'w2:p1', workspace: 'w2', cli: 'claude-code', rules: 'option' },
        [SEAT]: { stage: 'ready', pane: 'w3:p1', workspace: 'w3', cli: 'codex', rules: 'message' },
      },
      worktrees: {},
      watch: { pid: 4242, heartbeat: '2026-10-04T09:00:00.000Z' },
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

function runningAgent(name: string, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? '', status: 'idle', cwd: null };
}

// A caller placed by fake sources: its parent chain holds pane `pane`'s root process, and the
// session's agent list holds the pane under `name`. `session` is the session the placement is
// made in — the whole point of the cases below.
function placed(session: string | undefined, name: string | null, pane: string): Caller {
  const row = runningAgent(name ?? '', pane);
  const sources: CallerSources = {
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => [row],
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  };
  return session === undefined ? placeCaller(sources) : placeCaller(sources, session);
}

// The same fake sources, session-aware the way herdr is: the agent row is listed only when the
// command asks about `session` itself. Placed through the io seam, these are what a command
// that drops the session it judges in reads — an empty list, and a caller of nobody.
function sourcesOf(session: string, name: string, pane: string): (asked: string | undefined) => CallerSources {
  const row = runningAgent(name, pane);
  return (asked) => ({
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => (asked === session ? [row] : []),
    paneRootPid: (which) => (which === pane ? 200 : null),
    env: {},
    stdinIsTTY: true,
  });
}

// How a run's caller is handed to the command: placed the way the callers above are (a Caller),
// or placed through the fake sources, asked about the session the command judges in.
type Placement = Caller | { sources: (session: string | undefined) => CallerSources };

type Run = { code: number; out: string; err: string; before: string; beforeState: string };

// Every run starts from the file and the state as written: the same caller can be run twice
// against the same world, and a refusal can be checked against the bytes it started from.
async function call(
  runner: (io: TestIo) => Promise<number>,
  caller: Placement,
  options: { state?: Record<string, unknown> | null } = {},
): Promise<Run> {
  writeFileSync(file, FILE);
  const state = options.state === undefined ? (STATE as Record<string, unknown>) : options.state;
  if (state === null) rmSync(stateFile, { force: true });
  else writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');
  const beforeState = state === null ? '' : readFileSync(stateFile, 'utf8');
  const io = testIo(dir, 'sources' in caller ? undefined : caller);
  if ('sources' in caller) io.callerSources = caller.sources;
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

// The two refusal tails the commands share, each with the command's own name in front.
const NO_PANE = (name: string) =>
  `no pane is recorded for seat ${name} in this session: the owner stops that seat and runs \`team up\``;
const OWNER_ONLY = (who: string) => `--session is the owner's, from a terminal outside herdr; this call is ${who}`;

type Case = {
  name: string;
  run: (caller: Placement, argv?: string[], options?: { state?: Record<string, unknown> | null }) => Promise<Run>;
  // The refusal a caller that is not this team's sees, with the caller named as main named it.
  refusal: (who: string) => string;
  // The refusal for a caller of the right name and session the state records no pane for: the
  // cause, and the repair. For `answer` only the coordinator is ever a caller, so the operator
  // meets the ordinary refusal there instead of this line.
  noPane: (name: string) => string;
  // The refusal for a non-owner aiming `--session` elsewhere: the owner's flag alone.
  sessionOwner: (who: string) => string;
  // The owner's run: what the gate lets through, when nothing else refuses.
  owner: string;
};

const COMMANDS: Case[] = [
  {
    name: 'add',
    run: (caller, argv = [], options) => call((io) => runAdd(['probe-seat', ...argv], io, addSources()), caller, options),
    refusal: (who) => `team add: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team add: ${NO_PANE(name)}\n`,
    sessionOwner: (who) => `team add: ${OWNER_ONLY(who)}\n`,
    owner: `team add: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'remove',
    run: (caller, argv = [], options) => call((io) => runRemove([SEAT, ...argv], io, removeSources()), caller, options),
    refusal: (who) => `team remove: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team remove: ${NO_PANE(name)}\n`,
    sessionOwner: (who) => `team remove: ${OWNER_ONLY(who)}\n`,
    owner: '',
  },
  {
    name: 'worktree new',
    run: (caller, argv = [], options) =>
      call((io) => runWorktree(['new', 'probe-task', ...argv], io, worktreeSources()), caller, options),
    refusal: (who) => `team worktree: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team worktree: ${NO_PANE(name)}\n`,
    sessionOwner: (who) => `team worktree: ${OWNER_ONLY(who)}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'worktree remove',
    run: (caller, argv = [], options) =>
      call((io) => runWorktree(['remove', 'probe-task', ...argv], io, worktreeSources()), caller, options),
    refusal: (who) => `team worktree: only the owner, the coordinator or the operator runs it; this call is ${who}\n`,
    noPane: (name) => `team worktree: ${NO_PANE(name)}\n`,
    sessionOwner: (who) => `team worktree: ${OWNER_ONLY(who)}\n`,
    owner: `team worktree: ${NEVER_APPROVED}\n`,
  },
  {
    name: 'down',
    run: (caller, argv = [], options) => call((io) => runDown([...argv], io, downSources()), caller, options),
    refusal: (who) => `team down: only the owner, the coordinator or the operator stops the team; this call is ${who}\n`,
    noPane: (name) => `team down: ${NO_PANE(name)}\n`,
    sessionOwner: (who) => `team down: ${OWNER_ONLY(who)}\n`,
    owner: 'team down: this call has no way to reach herdr\n',
  },
  {
    name: 'answer',
    run: (caller, argv = [], options) => call((io) => runAnswer([SEAT, 'trust', ...argv], io, answerHost()), caller, options),
    refusal: () => `${SEAT}: only the owner, or the coordinator from its own seat, can answer\n`,
    noPane: (name) => `team answer: ${NO_PANE(name)}\n`,
    sessionOwner: (who) => `team answer: ${OWNER_ONLY(who)}\n`,
    owner: `${NEVER_APPROVED}\n`,
  },
];

const byName = (name: string): Case => {
  const found = COMMANDS.find((one) => one.name === name);
  if (!found) throw new Error(`no case named ${name}`);
  return found;
};

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
      // Handed in as a seat of its session: a caller that carries no session is refused once a
      // standing is asked for, so a readable caller names the session it stood in.
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    // The caller is placed through the fake caller sources, which answer for the session the
    // command asks them about — a command that drops the session it judges in reads an empty
    // agent list, places nobody, and this case fails.
    test('a caller placed through the sources of the team\'s own session is read as main read it', async () => {
      const judged = await command.run({ sources: sourcesOf(SESSION, COORDINATOR, COORDINATOR_PANE) });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    test('a state that records no pane refuses the coordinator: the cause and the repair', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), [], { state: null });
      // exit 1: <command>.no-pane, the case's own id (docs/reference/exit-codes.md).
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.noPane(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a state that records no pane refuses the operator the same way', async () => {
      const run = await command.run(placed(SESSION, OPERATOR, 'w4:p1'), [], { state: null });
      // `answer` judges the coordinator alone, so an operator is refused for being the operator,
      // not for the missing pane: the line it meets is its ordinary refusal.
      const err = command.name === 'answer' ? command.refusal(OPERATOR) : command.noPane(OPERATOR);
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a state that names another seat records no pane for the coordinator either', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), [], { state: TEMPORARY_STATE });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.noPane(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('a pane the state records for another seat is no standing either', async () => {
      // The caller sits on `w3:p1`, the pane the state records for codex-acme; the name it
      // holds has no record. Another seat's pane is not this seat's.
      const run = await command.run(placed(SESSION, COORDINATOR, 'w3:p1'), [], { state: TEMPORARY_STATE });
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.noPane(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    // The fixture is v0.2.1's own state shape (see STATE_021): if the release had not recorded
    // the pane in the field the gate reads, `judged` would be the no-pane refusal while `main`
    // passed, and the two sides would differ.
    test('a v0.2.1 state places the coordinator as main did: nothing breaks on upgrade', async () => {
      const judged = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), [], { state: STATE_021 });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION }, [], { state: STATE_021 });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });

    test('--session is the owner\'s: a seat aiming the check elsewhere is refused', async () => {
      const run = await command.run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--session', OTHER]);
      // exit 1: <command>.session-owner, the case's own id (docs/reference/exit-codes.md).
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.sessionOwner(COORDINATOR) });
      expect(readFileSync(file, 'utf8')).toBe(run.before);
    });

    test('the owner may aim --session: the gate lets it through', async () => {
      const flagged = await command.run({ kind: 'owner' }, ['--session', OTHER]);
      const plain = await command.run({ kind: 'owner' });
      expect({ code: flagged.code, out: flagged.out, err: flagged.err }).toEqual({ code: plain.code, out: plain.out, err: plain.err });
    });

    test('a temporary seat is no coordinator', async () => {
      const run = await command.run(placed(SESSION, SEAT, 'w3:p1'), [], { state: TEMPORARY_STATE });
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

    test('the owner is unaffected by a state that records no pane', async () => {
      const run = await command.run({ kind: 'owner' }, [], { state: null });
      if (command.name === 'remove') {
        expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 0, out: `removed ${SEAT}\n`, err: '' });
        return;
      }
      expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: command.owner });
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

  // The same call, aiming the check at the session that pane lives in. `--session` is the
  // owner's, so this is refused too — the binding cannot be defeated by choosing the session.
  test('remove --session <that session> removes nothing and exits 1', async () => {
    const run = await call(
      (io) => runRemove([SEAT, '--session', OTHER], io, removeSources()),
      placed(OTHER, COORDINATOR, COORDINATOR_PANE),
    );
    expect(run.code).toBe(1);
    expect(run.out).toBe('');
    expect(run.err).toBe(`team remove: ${OWNER_ONLY(COORDINATOR)}\n`);
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(stateFile, 'utf8')).toBe(run.beforeState);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });
});

// The dry runs fail the same way as the real runs: the refusal itself where the dry run sits
// behind the gate (`add`), and the `! down would refuse:` line over the plan where `down`
// prints it, still exiting 0.
describe('a dry run of the no-pane refusal', () => {
  test('add --dry-run is refused: the gate sits before the dry run', async () => {
    const run = await byName('add').run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--dry-run'], { state: null });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: byName('add').noPane(COORDINATOR) });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('down --dry-run prints the refusal as a would-refuse line and the plan, and exits 0', async () => {
    const run = await byName('down').run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--dry-run'], { state: null });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 0,
      // The state records nothing, so the plan is the session alone: no seat is left to skip.
      out:
        `! down would refuse: ${NO_PANE(COORDINATOR)}\n` +
        `+ herdr session stop ${SESSION}\n` +
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)\n' +
        'dry run: nothing was run\n',
      err: '',
    });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('down --dry-run would refuse a non-owner --session the same way', async () => {
    const run = await byName('down').run(placed(SESSION, COORDINATOR, COORDINATOR_PANE), ['--dry-run', '--session', OTHER]);
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({
      code: 0,
      out:
        `! down would refuse: ${OWNER_ONLY(COORDINATOR)}\n` +
        `+ herdr session stop ${OTHER}\n` +
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)\n' +
        'dry run: nothing was run\n',
      err: '',
    });
  });
});

// The host `up` drives, counted: over a state where every seat is ready and live, and over the
// refusal of the one it can't touch, none of these may be called. The shape is
// test/commands/live.test.ts's world(), trimmed to what these two runs can reach.
function upHost(): { counts: Record<'starts' | 'creates' | 'runs' | 'renames' | 'closes', number>; launch: Launch } {
  const counts = { starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 };
  const launch: Launch = {
    sessionState: () => 'running',
    startServer() {
      counts.starts++;
      return true;
    },
    sessionUp: () => true,
    createWorkspace() {
      counts.creates++;
      return null;
    },
    paneRun() {
      counts.runs++;
      return false;
    },
    renameAgent() {
      counts.renames++;
      return false;
    },
    closeWorkspace() {
      counts.closes++;
      return false;
    },
    agentPanes: () => [],
    agents: () => [],
    paneText: () => null,
    foreground: () => null,
    sleep: async () => {},
    now: () => new Date(0),
  };
  return { counts, launch };
}

function upSources(over: Partial<UpSources> = {}): UpSources {
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    home,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => new Date(0),
      home,
    },
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapFree: 8e9, swapUsed: 0 }),
    now: () => new Date(0),
    sleep: async () => {},
    alive: () => false,
    ...over,
  };
}

// The owner's one command after upgrading: a team brought up by v0.2.1 runs on, seat by seat,
// and `up` disturbs nothing — the state records every pane, the coordinator's included.
describe('up over the v0.2.1 state', () => {
  test('every seat is left as it is, and nothing is started, closed or renamed', async () => {
    writeFileSync(stateFile, `${JSON.stringify(STATE_021, null, 2)}\n`);
    const { counts, launch } = upHost();
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--file', '.agents/team.yaml'],
      io,
      upSources({
        agents: () => [
          runningAgent(COORDINATOR, COORDINATOR_PANE),
          runningAgent(OPERATOR, 'w2:p1'),
          runningAgent(SEAT, 'w3:p1'),
        ],
        workspaces: () => [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
        // The watch the 0.2.1 state records is alive; `up` leaves it alone too.
        alive: (pid) => pid === 4242,
        launch,
      }),
    );
    expect(code).toBe(0);
    expect(io.out).toBe(
      `  skip ${COORDINATOR}: already ready; left as it is\n` +
        `  skip ${OPERATOR}: already ready; left as it is\n` +
        `  skip ${SEAT}: already ready; left as it is\n`,
    );
    expect(counts).toEqual({ starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 });
    expect(readFileSync(stateFile, 'utf8')).toBe(`${JSON.stringify(STATE_021, null, 2)}\n`);
  });

  // The hole the refusal text stands on: while the unrecorded seat's pane is live, no owner
  // command records it — `up` refuses to touch a running team. This is the run that proves the
  // stop the repair names has to come first.
  test('a live agent the state does not record refuses up: that seat is stopped first', async () => {
    writeFileSync(stateFile, `${JSON.stringify(TEMPORARY_STATE, null, 2)}\n`);
    const { counts, launch } = upHost();
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--file', '.agents/team.yaml'],
      io,
      upSources({ agents: () => [runningAgent(COORDINATOR, COORDINATOR_PANE)], launch }),
    );
    expect(code).toBe(1);
    expect(io.err).toBe(
      `team up: session ${SESSION} has 1 agent this file's state doesn't record: \`up\` never touches a running team\n`,
    );
    expect(counts).toEqual({ starts: 0, creates: 0, runs: 0, renames: 0, closes: 0 });
    expect(readFileSync(file, 'utf8')).toBe(FILE);
    expect(readFileSync(stateFile, 'utf8')).toBe(`${JSON.stringify(TEMPORARY_STATE, null, 2)}\n`);
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

// The idle screen a launched seat shows: what `up` reads to call it ready. Each CLI's own —
// `readScreen` classifies by the seat's CLI, so the codex seat gets the codex fixture, with its
// composer line naming the model and version the team file declares.
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const CODEX_IDLE = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8').replace(
  'GPT-5.6-Terra medium ·',
  'GPT-6-Sol medium ·',
);

// The codex pane with typed text, in the registered unsent capture's shape: the pane's own
// header and warning rows, the typed rows under its prompt, the box's blank frame row, then the
// footer the model is read from. A first-message seat's rules are typed into it, so every row
// below the prompt is one line of the rules.
const CODEX_UNSENT = readFileSync(new URL('../fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8').replace(
  'GPT-5.6-Terra medium ·',
  'GPT-6-Sol medium ·',
);
const CODEX_HEAD = CODEX_UNSENT.split('\n').slice(0, 14);
const CODEX_FOOT = CODEX_UNSENT.split('\n')[19] ?? '';

function codexTyped(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  return [...CODEX_HEAD, `› ${first}`, ...rest.map((line) => `  ${line}`), '', CODEX_FOOT, ''].join('\n');
}

// A herdr that starts: every workspace gets its own pane, and the panes `up` handed out are
// listed back to it with a running agent in each.
function launching(): Launch {
  let n = 0;
  let running = false;
  const panes = new Map<string, { text: string; agent: boolean; cli: string; status: string }>();
  return {
    sessionState: () => (running ? 'running' : 'absent'),
    startServer() {
      running = true;
      return true;
    },
    sessionUp: () => running,
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: IDLE, agent: false, cli: 'claude', status: 'idle' });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      const known = panes.get(pane);
      if (known) {
        known.agent = true;
        known.cli = command.includes('codex') ? 'codex' : 'claude';
        known.text = known.cli === 'codex' ? CODEX_IDLE : IDLE;
      }
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, one]) => one.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    // The codex seat's rules are its first message: typing shows them in its composer, and the
    // Enter that sends them leaves the pane idle and working, as the registered captures show.
    // The claude seats take their rules as a launch option, so nothing is ever typed into them.
    typeText: (_session, pane, text) => {
      const known = panes.get(pane);
      if (!known) return false;
      known.text = known.cli === 'codex' ? codexTyped(text) : IDLE;
      return true;
    },
    pressEnter: (_session, pane) => {
      const known = panes.get(pane);
      if (!known) return false;
      known.text = known.cli === 'codex' ? CODEX_IDLE : IDLE;
      known.status = 'working';
      return true;
    },
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => [panes.get(pane)?.cli ?? 'claude'],
    sleep: async () => {},
    now: () => new Date(0),
  };
}

type UpState = {
  sessions: Record<string, { seats: Record<string, { pane?: string; stage?: string }>; worktrees: Record<string, unknown> }>;
};

// A team the owner started under another session: `team up --session <name>` writes its state
// under that session — the file names one session, the team runs under another — and the seats
// `up` started must still stand in every command, with no flag. Which session a caller is
// judged in comes from the caller's own placement and the state `up` wrote for it; `--session`
// stays the owner's own.
describe('a team run under another session', () => {
  // The real `up`, in-process on a fake host (never a real herdr), under the overridden session.
  // Returns the state it wrote and the pane it recorded for the coordinator's seat.
  async function upUnderOther(): Promise<{ state: UpState; pane: string }> {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runUp(
      ['--session', OTHER],
      io,
      upSources({ sessionRunning: () => false, sessionState: () => 'absent', launch: launching() }),
    );
    if (code !== 0) throw new Error(`the up run failed: ${io.err}${io.out}`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as UpState;
    const pane = state.sessions[OTHER]?.seats[COORDINATOR]?.pane;
    if (typeof pane !== 'string') throw new Error('up recorded no pane');
    return { state, pane };
  }

  for (const command of COMMANDS) {
    // The seat `up` started, placed through the fake caller sources on the pane the state
    // records — and the same caller handed in as a seat of that session, the way main read it —
    // meet the same run.
    test(`${command.name}: the coordinator's caller of that session passes, read as main read it`, async () => {
      const { state, pane } = await upUnderOther();
      const judged = await command.run({ sources: sourcesOf(OTHER, COORDINATOR, pane) }, [], { state });
      const main = await command.run({ kind: 'seat', name: COORDINATOR, pane, session: OTHER }, [], { state });
      expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    });
  }

  test('down with no flag stops the session the team actually runs under', async () => {
    const { state, pane } = await upUnderOther();
    const run = await byName('down').run({ sources: sourcesOf(OTHER, COORDINATOR, pane) }, ['--dry-run'], { state });
    expect(run.code).toBe(0);
    expect(run.out).toContain(`+ herdr session stop ${OTHER}\n`);
  });

  test('a caller on a pane the state records for no one in that session: the no-pane refusal', async () => {
    const { state, pane } = await upUnderOther();
    delete state.sessions[OTHER]?.seats[COORDINATOR];
    const run = await byName('remove').run({ sources: sourcesOf(OTHER, COORDINATOR, pane) }, [], { state });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: byName('remove').noPane(COORDINATOR) });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });

  test('a caller on another pane of that session: refused, and the file is untouched', async () => {
    const { state } = await upUnderOther();
    const run = await byName('remove').run({ sources: sourcesOf(OTHER, COORDINATOR, 'w9:p1') }, [], { state });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: byName('remove').refusal(COORDINATOR) });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
    expect(readFileSync(file, 'utf8')).toContain(`name: ${SEAT}`);
  });

  test('a caller placed in the file\'s own session is refused: that state records nothing', async () => {
    const { state } = await upUnderOther();
    const run = await byName('remove').run({ sources: sourcesOf(SESSION, COORDINATOR, COORDINATOR_PANE) }, [], { state });
    expect({ code: run.code, out: run.out, err: run.err }).toEqual({ code: 1, out: '', err: byName('remove').noPane(COORDINATOR) });
    expect(readFileSync(file, 'utf8')).toBe(run.before);
  });

  test('unless the file\'s own session records the pane too', async () => {
    const { state } = await upUnderOther();
    state.sessions[SESSION] = { seats: { [COORDINATOR]: { stage: 'ready', pane: COORDINATOR_PANE } }, worktrees: {} };
    const judged = await byName('remove').run({ sources: sourcesOf(SESSION, COORDINATOR, COORDINATOR_PANE) }, [], { state });
    const main = await byName('remove').run({ kind: 'seat', name: COORDINATOR, pane: COORDINATOR_PANE, session: SESSION }, [], { state });
    expect({ code: judged.code, out: judged.out, err: judged.err }).toEqual({ code: main.code, out: main.out, err: main.err });
    expect(judged.code).toBe(0);
  });
});
