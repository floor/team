import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { approvalDifferencesOf, budgetsInForceOf, notInForce, recordSeatDigestOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner, mayChangeTeam } from '../caller.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from '../commands/doctor.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import { rulesOf, type Launch } from '../commands/up.ts';
import { branchPresent, readMerge } from '../end/condition.ts';
import { clearStopped, hasSeat, restoreSeat, seatIsStopped } from '../file/lines.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import type { Problem, Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { writeTeamFile } from '../file/write.ts';
import {
  agentList, agentRename, paneForeground, paneRead, paneRun, sessionRunning, sessionState, startServer, workspaceClose, workspaceCreate,
  workspaceList, type HerdrAgent,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { executePlan, type Host } from '../launch/execute.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, readState, updateState, withLock, type SeatState, type SessionState } from '../state.ts';
import { approvalStanding, recordLedger, storePath, type Ceilings, type Standing } from '../store/store.ts';
import { launchLimit, readMachine, type Machine, type SwapSample } from '../watch/machine.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart, type SeatStart } from '../worktree/place.ts';

export type AddSources = {
  home: string;
  sessionState(session: string): 'absent' | 'running' | 'stopped' | null;
  agents(session: string): HerdrAgent[] | null;
  workspaces(session: string): { id: string }[] | null;
  doctor: DoctorSources;
  machine?: (root: string) => Machine;
  now(): Date;
  launch: Launch;
  // The approval store's one read, overridable so a test can count it or swap the record
  // after the gate. Absent: the real read.
  standing?(root: string): Standing;
  // The budget gate, overridable so a test can count its calls. Absent: the real gate.
  // The standing gate refuses before it is ever consulted.
  seatBudget?: typeof seatBudget;
};

const realLaunch: Launch = {
  sessionState,
  startServer,
  sessionUp: sessionRunning,
  createWorkspace: (session, cwd, label) => workspaceCreate(cwd, label, aim(session)),
  paneRun: (session, pane, command) => paneRun(pane, command, aim(session)),
  renameAgent: (session, pane, name) => agentRename(pane, name, aim(session)),
  closeWorkspace: (session, workspace) => workspaceClose(workspace, aim(session)),
  agentPanes(session) {
    const agents = agentList(aim(session));
    return agents === null ? null : agents.map((agent) => agent.pane);
  },
  paneText: (session, pane) => paneRead(pane, 200, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => new Date(),
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: AddSources = {
  home: homedir(),
  sessionState,
  agents: (session) => agentList(aim(session)),
  workspaces(session) {
    const listed = workspaceList(aim(session));
    return listed === null ? null : listed.map((workspace) => ({ id: workspace.id }));
  },
  doctor: doctorSources,
  machine: readMachine,
  now: () => new Date(),
  launch: realLaunch,
};

export const USAGE = `Usage: team add <name> [--dry-run] [--session <name>] [--file <path>]
       team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--dry-run] [--session <name>] [--file <path>]
`;

type Running = { name: string; vendor: string; temporary: boolean };
type Until = { kind: 'result'; path: string } | { kind: 'merged'; branch: string };

export const add: Command = (argv, io) => runAdd(argv, io, realSources);
export default add;

export async function runAdd(argv: string[], io: Io, sources: AddSources = realSources): Promise<number> {
  const args = readArgs(argv, ['like', 'until', 'worktree', 'session', 'file'], ['temporary', 'dry-run']);
  if (args.error) {
    io.stderr(`team add: ${args.error}\n${USAGE}`);
    // exit: add.invocation
    return 2;
  }
  const temporary = args.flags.has('temporary');
  if (temporary ? args.rest.length > 0 : args.rest.length !== 1) {
    io.stderr(`team add: ${temporary ? `unexpected "${args.rest[0]}"` : 'a seat name is required'}\n${USAGE}`);
    // exit: add.seat-name
    // exit: add.temporary-unexpected
    return 2;
  }
  if (!temporary && (args.values.like || args.values.until || args.values.worktree)) {
    io.stderr('team add: --like, --until and --worktree are for --temporary\n');
    // exit: add.temporary-flags
    return 2;
  }

  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) io.stderr(`team add: ${where(problem)}${problem.message}\n`);
    // exit: add.not-a-repo
    // exit: add.file
    // exit: add.file-invalid
    return 2;
  }
  const caller = callerOf(io);
  if (args.values.file && !isOwner(caller)) {
    io.stderr(`team add: --file is the owner's, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`);
    // exit: add.file-owner
    return 1;
  }
  if (!mayChangeTeam(caller, loaded.team)) {
    io.stderr(`team add: only the owner, the coordinator or the operator runs it; this call is ${describeCaller(caller)}\n`);
    // exit: add.caller
    return 1;
  }
  const { team, root, path } = loaded;
  const session = args.values.session ?? team.session;
  if (session === 'default') {
    io.stderr('team add: session can\'t be "default", herdr\'s own session\n');
    // exit: add.default-session
    return 1;
  }
  // One verified snapshot for the whole command: a legacy or refused record is not
  // an approval in force, and the approved copy the seat is built from is the record's own.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified') {
    io.stderr(`team add: ${notInForce(standing)}\n`);
    // exit: add.never-approved
    // exit: add.ceilings
    return 1;
  }
  const differences = approvalDifferencesOf(standing, team);
  if (differences.length) {
    io.stderr(`team add: the file is not the approved one (${differences.join('; ')}): run \`team approve\`\n`);
    // exit: add.differs
    return 1;
  }
  const approvedText = standing.record.file;
  const approved = validateTeamFile(approvedText);
  if (!approved.ok) {
    io.stderr('team add: the approved copy can\'t be read: run `team approve`\n');
    // exit: add.approved-copy
    return 1;
  }

  const dir = dirname(path);
  const live = sources.sessionState(session);
  if (live === null) {
    io.stderr('team add: herdr doesn\'t answer\n');
    // exit: add.herdr
    return 1;
  }
  if (live === 'stopped') {
    io.stderr(`team add: session ${session} is stopped; clear it with \`herdr session delete ${session}\`\n`);
    // exit: add.stopped
    return 1;
  }
  const agents = live === 'running' ? sources.agents(session) : [];
  // Read so a session whose workspace list can't be read is refused. The title is not a key.
  const workspaces = live === 'running' ? sources.workspaces(session) : [];
  if (agents === null || workspaces === null) {
    io.stderr(`team add: session ${session} runs, and its agents can't be read\n`);
    // exit: add.agents
    return 1;
  }

  const recorded = readState(dir).sessions[session] ?? emptySession();
  const ceilings: Ceilings = standing.record.approval.ceilings;

  const original = readFileSync(path, 'utf8');
  const built = temporary
    ? temporarySeat(args.values, original, approved.team, recorded, agents, root, team.workspace.base)
    : declaredSeat(args.rest[0] ?? '', original, approvedText, approved.team);
  if ('error' in built) {
    io.stderr(`team add: ${built.error}\n`);
    // exit: add.no-seat
    // exit: add.not-restored
    // exit: add.no-like
    // exit: add.until
    // exit: add.result-absolute
    // exit: add.result-exists
    // exit: add.merged-base
    // exit: add.branch-missing
    // exit: add.worktree-missing
    // exit: add.worktree-failed
    return 1;
  }
  if (agents.some((agent) => agent.name === built.name)) {
    io.stderr(`team add: ${built.name} is already running\n`);
    // exit: add.already-running
    return 1;
  }
  if (!profileFor(built.seat.cli)) {
    io.stderr(`team add: no launch profile for \`${built.seat.cli}\` in this version\n`);
    // exit: add.no-profile
    return 1;
  }

  const prepared = validateTeamFile(built.edited);
  if (!prepared.ok) {
    for (const problem of prepared.errors) io.stderr(`team add: ${where(problem)}${problem.message}\n`);
    // exit: add.prepared
    return 2;
  }
  for (const problem of placedProblems(prepared.team, root)) {
    io.stderr(`team add: ${problem.message}\n`);
    // exit: add.placed
    return 1;
  }
  // Where the seat waits: its own folder, the lobby, or a refusal — before the file is edited.
  const start: SeatStart = seatStart(prepared.team, built.seat, root);
  if ('problem' in start) {
    io.stderr(`team add: ${start.problem}\n`);
    // exit: add.start
    return 1;
  }
  const doctorTeam = built.temporary
    ? { ...prepared.team, seats: prepared.team.seats.map((item) => item.name === built.temporary?.like ? { ...item, stopped: false } : item) }
    : prepared.team;
  // `team` is the file on disk, already the approved one. `doctorTeam` is the
  // seat about to run, so a stopped seat's CLI is still checked. The digest is
  // recorded with the write, after a refusal has left the file alone.
  for (const finding of doctorFindings(doctorTeam, root, dir, session, sources.doctor, prepared.warnings, standing, team)) {
    if (blocksLaunch(finding)) {
      io.stderr(`team add: ${finding.text}\n`);
      // exit: add.doctor
      return 1;
    }
  }
  const samples: SwapSample[] = [];
  const crossed = () => {
    const machine = sources.machine?.(root);
    return machine ? launchLimit(machine, team.machine, samples, sources.now().getTime()) : null;
  };
  const problem = crossed();
  if (problem) {
    io.stderr(`team add: ${problem}\n`);
    // exit: add.machine
    return 1;
  }
  const running = runningOf(agents, prepared.team, recorded);
  const room = ceilingProblem(ceilings, running, built.seat, Boolean(built.temporary));
  if (room) {
    io.stderr(`team add: ${room}\n`);
    // exit: add.ceiling
    return 1;
  }
  const again = crossed();
  if (again) {
    io.stderr(`team add: ${again}\n`);
    // exit: add.machine-again
    return 1;
  }
  // The gate reads the approved budgets, never the edited file's: the seat this `add` inserts
  // changes no section of its own, and no unapproved reserve may unblock a launch (#50).
  const budgets = budgetsInForceOf(standing, prepared.team);
  const decision = (sources.seatBudget ?? seatBudget)(budgets, loadReadings(dir), built.seat, sources.now().getTime(), loadSpendReadings(dir));
  const stray = unnamedIn(recorded.seats[built.name]?.workspace, agents);
  const starting = seatPlan(prepared.team, built.seat, start);
  const planned = stray
    ? { ...starting, stage: 'launched' as const, pane: stray.pane, workspace: stray.workspace, agentLive: true }
    : starting;
  const wouldLaunch = planned.stage === undefined || !planned.pane || (planned.stage === 'launched' && !planned.agentLive);
  const seatForPlan = decision.kind === 'refuse' && !wouldLaunch ? { ...planned, budget: decision } : planned;
  const dry = args.flags.has('dry-run');
  if (dry) {
    if (decision.kind === 'refuse' && wouldLaunch) {
      io.stdout(`${built.name}: would refuse: ${decision.why}\ndry run: nothing was run\n`);
      // exit: add.dry-budget
      return 0;
    }
    if (decision.kind === 'unknown') io.stdout(`${built.name}: ${decision.text}\n`);
    const preview = upPlan({
      root,
      session,
      sessionRunning: live === 'running',
      seats: [seatForPlan],
      watchAlive: true,
    });
    io.stdout(formatPlan(preview));
    // exit: add.dry-run
    return 0;
  }
  if (decision.kind === 'refuse' && wouldLaunch) {
    io.stderr(`team add: refused: ${decision.why}\n`);
    // exit: add.budget
    return 1;
  }
  if (decision.kind === 'unknown') io.stdout(`${built.name}: ${decision.text}\n`);
  if (built.edited !== original) {
    const written = withLock(dir, () => {
      if (readFileSync(path, 'utf8') !== original) return { kind: 'changed' as const };
      const wrote = writeTeamFile(path, built.edited);
      return wrote.ok ? { kind: 'ok' as const } : { kind: 'invalid' as const, errors: wrote.errors };
    });
    if (written.kind === 'changed') {
      io.stderr('team add: the file changed while add was checking; nothing was written\n');
      // exit: add.changed
      return 1;
    }
    if (written.kind === 'invalid') {
      for (const problem of written.errors) io.stderr(`team add: ${where(problem)}${problem.message}\n`);
      // exit: add.locked
      return 2;
    }
    const parsed = validateTeamFile(built.edited);
    // The amendment re-signs from the command's own one snapshot, read at its gate.
    if (parsed.ok) recordSeatDigestOf(standing, parsed.team, root, built.name, sources.home);
  }

  const plan = upPlan({ root, session, sessionRunning: live === 'running', seats: [seatForPlan], watchAlive: true });
  const who = describeCaller(caller);
  const host = hostOf({
    dir, session, team: prepared.team, root, ceilings, running, seat: built.seat, temporary: built.temporary,
    caller: who, now: sources.now, launch: sources.launch, readMachine: sources.machine, samples, limits: team.machine, io,
  });
  const report = await executePlan(plan, session, host);
  const afterwards = readState(dir).sessions[session]?.seats[built.name];
  if (afterwards?.stage === 'ready' && built.temporary) {
    recordLedger(storePath(team.project, root, sources.home), [built.seat]);
  }
  const ready = afterwards?.stage === 'ready';
  if (ready) logLine(dir, 'add', who, `started ${built.name}${built.temporary ? ` like ${built.temporary.like} until ${built.temporary.until}` : ''}`, sources.now());
  // exit: add.ready
  // exit: add.not-ready
  // exit: add.server
  return ready && !report.serverFailed ? 0 : 1;
}

function declaredSeat(
  name: string, current: string, approvedText: string, approved: TeamFile,
): { name: string; seat: Seat; edited: string; temporary?: undefined } | { error: string } {
  const seat = approved.seats.find((item) => item.name === name);
  if (!seat) return { error: `the approved file has no seat ${JSON.stringify(name)}` };
  let edited = hasSeat(current, name) ? current : restoreSeat(current, approvedText, name);
  if (seat.stopped || seatIsStopped(edited, name)) edited = clearStopped(edited, name);
  const again = validateTeamFile(edited);
  const restored = again.ok ? again.team.seats.find((item) => item.name === name) : undefined;
  if (!restored) return { error: `couldn't put ${name} back from the approved copy` };
  return { name, seat: { ...restored, stopped: false }, edited, temporary: undefined };
}

function temporarySeat(
  values: Record<string, string>, current: string, approved: TeamFile, state: SessionState, agents: readonly HerdrAgent[],
  root: string, base: string | null,
): { name: string; seat: Seat; edited: string; temporary: NonNullable<SeatState['temporary']> } | { error: string } {
  const like = approved.seats.find((item) => item.name === values.like);
  if (!like) return { error: `the approved file has no seat ${JSON.stringify(values.like)}` };
  const until = parseUntil(values.until ?? '');
  if (!until) return { error: '--until is result:<path> or merged:<branch>' };
  let own: boolean | undefined;
  if (until.kind === 'result') {
    if (until.path.startsWith('/') || until.path.startsWith('~')) return { error: 'a result path is relative to the project' };
    if (existsSync(resolve(root, until.path))) return { error: `${until.path} already exists` };
  } else if (!base) {
    return { error: 'workspace.base is required to read a merged end' };
  } else {
    const read = readMerge(root, until.branch, base, false);
    const here = branchPresent(root, until.branch);
    if (read.detail.includes('the branch is gone') || here === false) return { error: `branch ${until.branch} doesn't exist` };
    if (here !== true && read.verdict === 'unproven') return { error: read.detail };
    own = read.ownNow > 0;
  }
  const task = values.worktree;
  const worktree = task ? state.worktrees[task] : undefined;
  if (task && !worktree) return { error: `no worktree named ${JSON.stringify(task)} is recorded` };
  if (worktree?.setup === 'failed') return { error: `worktree ${task} has a failed setup; team worktree remove ${task}` };
  const name = temporaryName(like.name, approved, state, agents);
  return {
    name,
    edited: current,
    seat: { ...like, name, label: name, cwd: worktree?.path ?? like.cwd, stopped: false },
    temporary: {
      like: like.name,
      until: values.until ?? '',
      ...(task ? { task } : {}),
      ...(until.kind === 'merged' && !task && own !== undefined ? { own_commits: own } : {}),
    },
  };
}

function temporaryName(like: string, team: TeamFile, state: SessionState, agents: readonly HerdrAgent[]): string {
  const used = new Set([...team.seats.map((seat) => seat.name), ...Object.keys(state.seats), ...agents.map((agent) => agent.name ?? '')]);
  let n = 1;
  while (used.has(`${like}-tmp-${n}`)) n++;
  return `${like}-tmp-${n}`;
}

function parseUntil(value: string): Until | null {
  if (value.startsWith('result:') && value.length > 'result:'.length) return { kind: 'result', path: value.slice('result:'.length) };
  if (value.startsWith('merged:') && value.length > 'merged:'.length) return { kind: 'merged', branch: value.slice('merged:'.length) };
  return null;
}

function seatPlan(team: TeamFile, seat: Seat, start: { cwd: string; lobby?: true }): UpSeat {
  return {
    name: seat.name,
    cli: seat.cli,
    launch: seat.launch,
    cwd: start.cwd,
    label: seat.label,
    model: seat.model,
    version: seat.version,
    stopped: false,
    rules: rulesOf(team, seat),
    ...(start.lobby ? { lobby: true } : {}),
  };
}

function unnamedIn(workspace: string | undefined, agents: readonly HerdrAgent[]): HerdrAgent | undefined {
  if (!workspace) return undefined;
  return agents.find((agent) => !agent.name && agent.workspace === workspace);
}

function runningOf(agents: readonly HerdrAgent[], team: TeamFile, state: SessionState): Running[] {
  const seats = new Map(team.seats.map((seat) => [seat.name, seat]));
  const running: Running[] = [];
  for (const agent of agents) {
    if (!agent.name) continue;
    const seat = seats.get(agent.name);
    const known = state.seats[agent.name];
    if (!seat && !known?.temporary) continue;
    const like = known?.temporary ? seats.get(known.temporary.like) : undefined;
    running.push({ name: agent.name, vendor: seat?.vendor ?? like?.vendor ?? 'unknown', temporary: Boolean(known?.temporary) });
  }
  return running;
}

function ceilingProblem(ceilings: Ceilings, running: readonly Running[], seat: Seat, temporary: boolean): string | null {
  if (running.some((item) => item.name === seat.name)) return null;
  if (running.length + 1 > ceilings.seats) return `the approval allows ${ceilings.seats} seats; ${running.length + 1} would be running`;
  if (temporary && running.filter((item) => item.temporary).length + 1 > ceilings.temporary) {
    return `the approval allows ${ceilings.temporary} temporary seats; ${running.filter((item) => item.temporary).length + 1} would be running`;
  }
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor).length + 1;
    if (vendors > cap) return `the approval allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
  }
  return null;
}


function where(problem: Problem): string {
  return problem.line ? `line ${problem.line}: ` : '';
}

function hostOf(input: {
  dir: string; session: string; team: TeamFile; root: string; ceilings: Ceilings; running: Running[];
  seat: Seat; temporary?: SeatState['temporary']; caller: string; now(): Date; launch: Launch;
  readMachine?: (root: string) => Machine; samples: SwapSample[]; limits: TeamFile['machine']; io: Io;
}): Host {
  const { dir, session, launch, seat, temporary } = input;
  const running = [...input.running];
  return {
    startServer: launch.startServer,
    sessionUp: launch.sessionUp,
    makeDir(path) {
      try {
        mkdirSync(path, { recursive: true });
        return true;
      } catch {
        return false;
      }
    },
    createWorkspace: launch.createWorkspace,
    paneRun: launch.paneRun,
    typeLine: () => false,
    renameAgent: launch.renameAgent,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    kill: () => false,
    agentPanes: launch.agentPanes,
    classify: (_name, pane, cli) => readScreen(cli, launch.paneText(session, pane) ?? undefined).kind,
    text: (_name, pane) => launch.paneText(session, pane) ?? undefined,
    sleep: launch.sleep,
    now: () => input.now().getTime(),
    allow(name) {
      if (input.readMachine) {
        const problem = launchLimit(input.readMachine(input.root), input.limits, input.samples, input.now().getTime());
        if (problem) return problem;
      }
      if (name !== seat.name) return null;
      return ceilingProblem(input.ceilings, running, seat, Boolean(temporary));
    },
    record(name, patch) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[name] ?? { stage: patch.stage };
        current.seats[name] = { ...prior, ...patch, ...(temporary && name === seat.name ? { temporary } : {}) };
      });
    },
    running(name) {
      if (!running.some((item) => item.name === name)) running.push({ name, vendor: seat.vendor, temporary: Boolean(temporary) });
    },
    drop(name) {
      updateState(dir, (file) => {
        const seats = file.sessions[session]?.seats;
        if (seats) delete seats[name];
      });
    },
    say: (line) => input.io.stdout(line),
    log: (who, what) => logLine(dir, 'add', input.caller, `${who}: ${what}`, input.now()),
  };
}
