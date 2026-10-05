import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalDifferencesOf, budgetsInForceOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerLabel, callerOf, describeCaller, mayLaunchSeats } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { isLegacyTrust, isMigratedTrust } from '../file/paths.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import {
  agentList,
  agentStatus,
  agentRename,
  focusAgent,
  paneForeground,
  paneProcesses,
  paneRead,
  paneRun,
  paneShellBack,
  sessionStop,
  typeText,
  pressEnter,
  sessionRunning,
  sessionState,
  startServer,
  workspaceClose,
  workspaceCreate,
  workspaceList,
  workspacePanes,
  type HerdrAgent,
  type HerdrWorkspace,
  type PaneProcesses,
  type SessionState,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { launchedIdentity, seatProcessVerdict } from '../launch/identity.ts';
import { launchLineFinding } from '../launch/line.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { runPause, type PauseHost, type PauseInput } from '../launch/pause.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { recordWhat, progressWriter } from '../launch/progress.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { processSignals, terminalReader, type Terminal } from '../launch/terminal.ts';
import { trustPolicy } from '../file/dialogs.ts';
import { rulesOf } from '../launch/rules.ts';
import { rulesFileHash, rulesFileHolds, seatDeliveryOf, typeablePath, writeRulesFile } from '../launch/rules-file.ts';
import { deliverRules, fileRefusalOf, type Refusal } from '../launch/deliver.ts';
import { lobbyDir, recheckLobby, verifyLobby, type FsReader, type LobbySeen } from '../lobby/gate.ts';
import { logLine } from '../log.ts';
import { shellQuote } from '../profiles/profile.ts';
import { profileFor } from '../profiles/index.ts';
import { approvalStanding, type Ceilings, type Standing } from '../store/store.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { seatBudget } from '../budgets/gate.ts';
import { loadReadings, loadSpendReadings } from '../budgets/readings.ts';
import { blocksLaunch, doctorFindings, realSources as doctorSources, type DoctorSources } from './doctor.ts';
import { launchLimit, readMachine, type Machine, type SwapSample } from '../watch/machine.ts';
import { readScreen } from '../watch/screen.ts';
import { seatStart } from '../worktree/place.ts';

// What `up` reads from outside the file, so tests can stand in for it.
export type UpSources = {
  sessionRunning(session: string): boolean | null;
  sessionState?(session: string): SessionState | null;
  agents(session: string): HerdrAgent[] | null;
  /** The session's workspaces with their labels now; null when herdr can't tell. The waiting
   *  proof compares a pane's workspace label with the seat's launch label. */
  workspaces?(session: string): HerdrWorkspace[] | null;
  home: string;
  getuid?(): number;
  fs?: FsReader;
  doctor?: DoctorSources;
  machine?(root: string): Machine;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
  alive?(pid: number): boolean;
  watchCommand?(session: string): string;
  // The owner's terminal, for the pause at a dialog. Absent: Node's own stdin, read in raw
  // mode for one key at a time (`terminal.ts`). A dry run and a caller without a terminal
  // never read it.
  terminal?(): Terminal;
  // The approval store's one read, overridable so a test can count it or swap the record
  // after the gate. Absent: the real read.
  standing?(root: string): Standing;
  // The budget gate, overridable so a test can count its calls. Absent: the real gate.
  // A standing that is not verified refuses below before this is consulted at all.
  seatBudget?: typeof seatBudget;
  // Present on the shipped command. A dry run never calls it.
  launch?: Launch;
};

export type Launch = {
  sessionState(session: string): SessionState | null;
  startServer(session: string): boolean;
  sessionUp(session: string): boolean | null;
  createWorkspace(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  paneRun(session: string, pane: string, command: string): boolean;
  renameAgent(session: string, pane: string, name: string): boolean;
  closeWorkspace(session: string, workspace: string): boolean;
  agentPanes(session: string): string[] | null;
  /** The session's agents as herdr lists them now; null when the list can't be read. */
  agents(session: string): HerdrAgent[] | null;
  /** Pane ids in a workspace as herdr lists them now; null when the list can't be read. */
  workspacePanes?(session: string, workspace: string): string[] | null;
  paneText(session: string, pane: string): string | null;
  typeText?(session: string, pane: string, text: string): boolean;
  pressEnter?(session: string, pane: string): boolean;
  agentStatus?(session: string, pane: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Whether the pane's foreground program is back to its shell; null when herdr can't tell. */
  shellBack?(session: string, pane: string): boolean | null;
  /** The pane's process identity, compared with the one recorded for the seat. */
  processInfo?(session: string, pane: string): PaneProcesses | null;
  /** Brings the pane to the owner's attention, without sending a key or a text into it. */
  focus?(session: string, pane: string): boolean;
  /** Stops the session (`q` in the pause, only for a session this invocation started). */
  stopSession?(session: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

/** The watchdog command, from this process and this install: `team` may not be on the PATH. */
export function watchCommand(session: string): string {
  const here = fileURLToPath(import.meta.url);
  const cli = join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  const suffix = session === 'default' ? '' : ` --session ${shellQuote(session)}`;
  return `${shellQuote(process.execPath)} ${shellQuote(cli)} watch${suffix}`;
}

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
  agents: (session) => agentList(aim(session)),
  workspacePanes: (session, workspace) => workspacePanes(workspace, aim(session)),
  paneText: (session, pane) => paneRead(pane, 200, aim(session)),
  typeText: (session, pane, text) => typeText(pane, text, aim(session)),
  pressEnter: (session, pane) => pressEnter(pane, aim(session)),
  agentStatus: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  processInfo: (session, pane) => paneProcesses(pane, aim(session)),
  focus: (session, pane) => focusAgent(pane, aim(session)),
  stopSession: (session) => sessionStop(session),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export const realSources: UpSources = {
  sessionRunning,
  sessionState,
  agents: (session) => agentList(aim(session)),
  workspaces: (session) => workspaceList(aim(session)),
  home: homedir(),
  getuid: () => process.getuid?.() ?? 0,
  doctor: doctorSources,
  machine: readMachine,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  watchCommand,
  launch: realLaunch,
};

export const USAGE = 'Usage: team up [--dry-run] [--session <name>] [--file <path>]\n';

export const up: Command = (argv, io) => runUp(argv, io, realSources);
export default up;

function resolveState(sources: UpSources, session: string): SessionState | null {
  if (sources.sessionState) return sources.sessionState(session);
  const running = sources.sessionRunning(session);
  if (running === null) return null;
  return running ? 'running' : 'absent';
}

type Running = { name: string; vendor: string; temporary: boolean };

function overCeiling(ceilings: Ceilings, running: readonly Running[], seat: Seat): string | null {
  if (running.some((item) => item.name === seat.name)) return null;
  const count = running.length + 1;
  if (count > ceilings.seats) return `the approval allows ${ceilings.seats} seats; ${count} would be running`;
  const cap = ceilings.vendors[seat.vendor];
  if (cap !== undefined) {
    const vendors = running.filter((item) => item.vendor === seat.vendor).length + 1;
    if (vendors > cap) return `the approval allows ${cap} ${seat.vendor} seats; ${vendors} would be running`;
  }
  return null;
}

function seatPlan(
  standing: Standing,
  team: TeamFile,
  seat: Seat,
  recorded: SeatState | undefined,
  agents: readonly HerdrAgent[],
  workspaces: HerdrWorkspace[] | null,
  resume: boolean,
  root: string,
  home: string,
  processes: Readonly<Record<string, PaneProcesses | null>> = {},
): UpSeat {
  const planned: UpSeat = {
    name: seat.name,
    cli: seat.cli,
    launch: seat.launch,
    cwd: seat.cwd,
    label: seat.label,
    model: seat.model,
    version: seat.version,
    stopped: seat.stopped,
    // An option seat's rules keep coming from the live file, as main's launch line does; a
    // message seat's file and line are the approved copy's, whatever the live file says now.
    rules: rulesOf(team, seat, root),
    ...seatDeliveryOf(standing, team, seat, root, home),
  };
  if (!resume || !recorded || seat.stopped) return planned;
  // §5: a seat recorded waiting takes precedence over everything below. Its recorded pane and
  // workspace are reused — never launched again — whatever the process verdict says: the pause
  // reads the pane fresh and verifies it before doing anything, and a pane that is gone is a
  // fail-closed refusal there, not a reason to create another workspace.
  if (recorded.waiting) {
    return {
      ...planned,
      ...(recorded.stage ? { stage: recorded.stage } : {}),
      ...(recorded.pane ? { pane: recorded.pane } : {}),
      ...(recorded.workspace ? { workspace: recorded.workspace } : {}),
      waiting: recorded.waiting,
      ...(recorded.launched ? { waitingLaunched: recorded.launched } : {}),
    };
  }
  // The pane is the seat only while the process team launched is still in it: a pane that runs
  // no CLI, or one whose process is not the recorded one, is not the seat. Its workspace is
  // closed without input and the seat is launched fresh — the stage it stopped at is not
  // resumed. No workspace recorded, no close to make: the seat is left as it is. The close
  // itself reads herdr again, immediately before it (`execute.ts`), so this reading only
  // decides that the seat needs repair, never that its recorded workspace is still its own.
  const verdict = seatProcessVerdict(recorded.launched, processes[seat.name] ?? null);
  if ((verdict === 'gone' || verdict === 'replaced') && recorded.workspace && recorded.pane && recorded.launched) {
    return {
      ...planned,
      repair: { pane: recorded.pane, workspace: recorded.workspace, launched: recorded.launched, cli: seat.cli },
    };
  }
  const named = agents.find((agent) => agent.name === seat.name);
  const onPane = recorded.pane ? agents.some((agent) => agent.pane === recorded.pane) : false;
  if (recorded.stage === 'ready') return named || onPane ? { ...planned, stage: 'ready' } : planned;
  const workspaceLive =
    recorded.workspace && workspaces ? workspaces.some((workspace) => workspace.id === recorded.workspace) : null;
  const live = Boolean(named || onPane || workspaceLive);
  if (!live) return planned;
  return {
    ...planned,
    stage: recorded.stage,
    pane: recorded.pane,
    workspace: recorded.workspace,
    agentLive: Boolean(named || onPane),
  };
}

export async function runUp(argv: string[], io: Io, sources: UpSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['dry-run']);
  if (args.error || args.rest.length) {
    io.stderr(`team up: ${plainText(args.error ?? `unexpected "${args.rest[0]}"`)}\n${USAGE}`);
    // exit: up.invocation
    return 2;
  }
  const dry = args.flags.has('dry-run');
  const loaded = loadTeamFile(io.cwd, { ...(args.values.file ? { file: args.values.file } : {}), home: sources.home });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team up: ${problem.line ? `line ${problem.line}: ` : ''}${plainText(problem.message)}\n`);
    }
    // exit: up.not-a-repo
    // exit: up.file
    // exit: up.file-invalid
    return 2;
  }
  const { team, root } = loaded;
  const session = args.values.session ?? team.session;
  const dir = dirname(loaded.path);
  const state = resolveState(sources, session);

  // What would make `up` refuse. A dry run prints the plan anyway; a real run stops first.
  const refusals: string[] = [];
  const caller = callerOf(io);
  if (!mayLaunchSeats(caller)) {
    refusals.push(`only the owner runs \`up\`, from a terminal outside herdr; this call is ${describeCaller(caller)}`);
  }
  // One verified snapshot carries the whole command: the refusal when there is
  // one, and the ceilings the launch holds. A legacy or refused record is not
  // an approval in force, and says so in its own words.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified') refusals.push(notInForce(standing));
  else {
    const differences = approvalDifferencesOf(standing, team);
    if (differences.length) {
      refusals.push(`the file is not the approved one (${differences.join('; ')}): run \`team approve\``);
    }
  }
  // The budget readings the gate refuses on are the approved ones: an unapproved lower reserve
  // unblocks nothing, not even the seat a dry run would plan.
  const budgets = budgetsInForceOf(standing, team);

  if (sources.doctor) {
    const findings = doctorFindings(team, root, dir, session, sources.doctor, loaded.warnings, standing);
    for (const finding of findings) if (blocksLaunch(finding)) refusals.push(finding.text);
  }
  const samples: SwapSample[] = [];
  const readAt = () => (sources.now?.() ?? new Date()).getTime();
  const crossed = (machine: Machine) => launchLimit(machine, team.machine, samples, readAt());
  const machine = sources.machine?.(root);
  if (machine) {
    const problem = crossed(machine);
    if (problem) refusals.push(problem);
  }

  if (state === null) refusals.push("herdr doesn't answer");
  if (state === 'stopped') {
    refusals.push(`session ${session} is stopped; clear it with \`herdr session delete ${session}\``);
  }
  const agents = state === 'running' ? sources.agents(session) : [];
  if (state === 'running') {
    const recorded = readState(dir).sessions[session]?.seats ?? {};
    if (agents === null) refusals.push(`session ${session} runs, and its agents can't be read`);
    else {
      // §5: a seat recorded waiting was left in its pane for the owner — by `add`, whose seat
      // was never renamed, so herdr lists its pane with no `name` field at all. That agent is
      // known by its pane, whatever its name is now: the resume path verifies pane and process
      // itself, and its prompt is the only way the owner can finish the seat.
      const waitingPanes = new Set(
        Object.values(recorded)
          .filter((seat) => seat.waiting)
          .map((seat) => seat.pane)
          .filter((pane) => pane !== undefined),
      );
      const unknown = agents.filter(
        (agent) => !(agent.name && Object.hasOwn(recorded, agent.name)) && !waitingPanes.has(agent.pane),
      );
      if (unknown.length) {
        refusals.push(
          `session ${session} has ${unknown.length} agent${unknown.length === 1 ? '' : 's'} this file's state doesn't record: \`up\` never touches a running team`,
        );
      }
    }
  }

  const lobby = lobbyDir(sources.home);
  if (!team.trust || team.trust.length === 0 || isLegacyTrust(team.trust)) {
    refusals.push(
      `the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\ntrust:\n  - ~/.config/team/lobby\n  - ${root}`,
    );
  }

  const recorded = readState(dir).sessions[session];
  const workspaces = sources.workspaces?.(session) ?? null;
  // What each recorded seat's pane holds, read from its pane: what decides whether the seat is
  // still the seat, or whether it must be launched again. Only a running session has panes, and
  // a herdr that can't tell gives null — read exactly as a seat with no record.
  const processes: Record<string, PaneProcesses | null> = {};
  if (state === 'running' && sources.launch?.processInfo) {
    for (const [name, held] of Object.entries(recorded?.seats ?? {})) {
      if (held.launched && held.pane) processes[name] = sources.launch.processInfo(session, held.pane);
    }
  }
  const readings = loadReadings(dir);
  const spend = loadSpendReadings(dir);
  // What makes a standing that is not verified safe is not the defaults' own values —
  // `defaultBudgets` names no account, and `seatBudget` reads it `clear`: permissive as a
  // value. It is the ordering: the refusal above is carried into every exit below, and this
  // guard keeps the planning pass from consulting a budget at all, so an unapproved file
  // buys nothing from the budget, not even a mark in a dry run's plan.
  const budgetGate = sources.seatBudget ?? seatBudget;
  const budgetOf = (seat: (typeof team.seats)[number]) =>
    standing.kind === 'verified' ? budgetGate(budgets, readings, seat, readAt(), spend) : { kind: 'clear' as const };
  // One writer per run: a seat's provisional line on a terminal, its one final record either
  // way, and every other line of the run on stderr, after the record it belongs to. It exists
  // from here, before the planning pass, because the launch-line note is one of its detail lines.
  const records = progressWriter({ stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutIsTTY ?? false });
  const seats: UpSeat[] = [];
  const refused = new Set<string>();
  for (const seat of team.seats) {
    const planned = seatPlan(standing, team, seat, recorded?.seats[seat.name], agents ?? [], workspaces, state === 'running', root, sources.home, processes);
    // A stopped seat, one without a profile, and one already ready are left out of the budget.
    // A seat resumed into a live workspace starts nowhere new, but its reading is still said.
    if (planned.stopped || !profileFor(seat.cli) || planned.stage === 'ready') {
      seats.push(planned);
      continue;
    }
    const placed = planned.stage === undefined || !planned.pane;
    // The seat's own launch line, checked where the seat starts: a `miss` leaves this seat out
    // before its workspace is made, and the other seats go on. A note is told, never refused —
    // once, on the terminal, and on stderr on a real run as `doctor` says it. A seat resumed
    // into an existing pane is checked where that pane runs, when the state records it
    // (`start_cwd`); without it the line is not checked at all — the file's folder is not
    // where that pane is, so refusing or passing on it would be a guess.
    const doctor = sources.doctor;
    const resumeCwd = recorded?.seats[seat.name]?.start_cwd;
    const line = doctor
      ? placed
        ? launchLineFinding(team, seat, root, { onPath: (binary) => doctor.onPath(binary), home: doctor.home })
        : typeof resumeCwd === 'string' && resumeCwd !== ''
          ? launchLineFinding(
              team,
              seat,
              root,
              { onPath: (binary) => doctor.onPath(binary), home: doctor.home },
              { cwd: resolve(root, resumeCwd), folder: resumeCwd },
            )
          : {
              level: 'note' as const,
              why: 'its launch line was not checked: the seat is resumed and its state records no start folder',
            }
      : null;
    // The note is the writer's detail line on a real run: one line, cleaned like a record's
    // fields, whatever the launch line's word holds. A dry run has no run, and its note goes to
    // stdout with the plan it belongs to.
    if (line?.level === 'note') {
      const note = `  note ${seat.name}: ${line.why}`;
      if (dry) io.stdout(`${plainLine(note)}\n`);
      else records.detail(note);
    }
    // The plan, the record and the log hold the reason in words (`record`); the full finding —
    // the start folder it names — rides along as the record's stderr detail only.
    const launchProblem =
      line?.level === 'miss'
        ? {
            launchProblem: line.record ?? line.why,
            ...(line.record ? { launchProblemDetail: line.why } : {}),
          }
        : {};
    if (!placed) {
      const budget = budgetOf(seat);
      seats.push({ ...planned, ...launchProblem, ...(budget.kind === 'clear' ? {} : { budget }) });
      continue;
    }
    const start = seatStart(team, seat, root, sources.home);
    if ('problem' in start) {
      if (!start.once || !refused.has(start.problem)) {
        refused.add(start.problem);
        refusals.push(start.problem);
      }
      continue;
    }
    const budget = budgetOf(seat);
    seats.push({
      ...planned,
      cwd: start.cwd,
      ...(start.lobby ? { lobby: true } : {}),
      ...launchProblem,
      ...(budget.kind === 'clear' ? {} : { budget }),
    });
  }
  let verifiedLobby: string | null = null;
  let lobbySeen: LobbySeen | null = null;
  if (isMigratedTrust(team.trust)) {
    const launching = seats.some((seat) => {
      if (seat.stopped || seat.launchProblem) return false;
      if (!profileFor(seat.cli)) return false;
      const fresh = seat.stage === undefined || !seat.pane || (seat.stage === 'launched' && !seat.agentLive);
      if (!fresh) return false;
      return seat.budget?.kind !== 'refuse';
    });
    const gate = verifyLobby(sources.home, {
      create: !dry && refusals.length === 0 && launching,
      getuid: sources.getuid,
      fs: sources.fs,
    });
    if (!gate.ok) refusals.push(gate.text);
    else if ('path' in gate) {
      verifiedLobby = gate.path;
      lobbySeen = { path: gate.path, dev: gate.dev, ino: gate.ino };
      for (const seat of seats) if (seat.lobby) seat.cwd = gate.path;
    }
  }
  const watch = recorded?.watch;
  const plan = upPlan({
    root,
    session,
    // A stopped session is not started. The refusal above names the delete command.
    sessionRunning: state === 'running' || state === 'stopped',
    seats,
    watchAlive: Boolean(watch && sources.alive?.(watch.pid)),
    watchLine: (sources.watchCommand ?? watchCommand)(session),
  });

  if (dry) {
    // The same cause can reach the list twice — the gate and `doctor` both read the
    // approval — so a refusal is said once.
    for (const refusal of [...new Set(refusals)]) io.stdout(`! up would refuse: ${plainText(refusal)}\n`);
    io.stdout(plainText(formatPlan(plan)));
    // exit: up.dry-run
    return 0;
  }
  if (refusals.length) {
    for (const refusal of [...new Set(refusals)]) io.stderr(`team up: ${plainText(refusal)}\n`);
    // exit: up.not-owner
    // exit: up.never-approved
    // exit: up.differs
    // exit: up.doctor
    // exit: up.machine
    // exit: up.herdr
    // exit: up.stopped
    // exit: up.agents
    // exit: up.unknown
    // exit: up.placement
    return 1;
  }
  const launch = sources.launch;
  if (!launch) {
    io.stderr('team up: this call has no way to reach herdr\n');
    // exit: up.no-launch
    return 1;
  }

  // The ceilings the launch holds are the verified record's own, fixed at approval.
  const ceilings: Ceilings | null = standing.kind === 'verified' ? standing.record.approval.ceilings : null;
  const running: Running[] = [];
  if (agents) {
    const byName = new Map(team.seats.map((seat) => [seat.name, seat]));
    for (const agent of agents) {
      if (!agent.name) continue;
      const seat = byName.get(agent.name);
      const known = recorded?.seats[agent.name];
      if (!seat && !known) continue;
      const like = known?.temporary?.like;
      const vendor = seat?.vendor ?? (like ? byName.get(like)?.vendor : undefined) ?? 'unknown';
      running.push({ name: agent.name, vendor, temporary: Boolean(known?.temporary) });
    }
  }
  const now = () => sources.now?.() ?? launch.now();
  const host: Host = {
    startServer: launch.startServer,
    sessionUp: launch.sessionUp,
    createWorkspace: launch.createWorkspace,
    // The lobby is read again directly before each workspace this run makes in it, with nothing
    // in between (`execute.ts`). Null when it is still the folder the gate read.
    confirmLobby() {
      return lobbySeen ? recheckLobby(sources.home, lobbySeen, { getuid: sources.getuid, fs: sources.fs }) : null;
    },
    paneRun: launch.paneRun,
    typeLine: () => false,
    deliverRules: async (session, pane, cli, file, seconds) => {
      // The rules go to the file first; nothing is typed until it holds them. The writer
      // builds the path itself, from the approval in force and the seat's name.
      const written = writeRulesFile(standing, file.seat, root, sources.home, file.text, rulesFileHash(file.text));
      if (!written.ok) return fileRefusalOf(written);
      // The plan already refused a path that can't be typed; this is the same check again, so a
      // path that reached this far by a caller's mistake is refused before anything is typed.
      if (!typeablePath(file.path)) {
        return { stop: 'path', typed: false, sent: false, kind: 'unknown' as const, row: null };
      }
      // The delivery reports why it stopped through this box; the caller turns the stopped
      // reading into the report, and a plain refusal stays `false`.
      const stopped: { why: Refusal | null } = { why: null };
      const delivered = await deliverRules(cli, file.line, seconds, {
        screen: () => launch.paneText(session, pane) ?? undefined,
        status: () => launch.agentStatus?.(session, pane) ?? null,
        type: (value) => launch.typeText?.(session, pane, value) ?? false,
        enter: () => launch.pressEnter?.(session, pane) ?? false,
        // The last look before Enter: the file, read without following a link, must still hold
        // the text whose hash the line names.
        file: () => rulesFileHolds(file.path, rulesFileHash(file.text)),
        foreground: () => launch.foreground(session, pane),
        report: (why) => { stopped.why = why; },
        now: () => now().getTime(),
        sleep: sources.sleep ?? launch.sleep,
      });
      return delivered === false && stopped.why !== null ? stopped.why : delivered;
    },
    renameAgent: launch.renameAgent,
    closeWorkspace: launch.closeWorkspace,
    stopSession: (session) => launch.stopSession?.(session) ?? false,
    kill: () => false,
    agentPanes: launch.agentPanes,
    agentList: launch.agents,
    // The session's workspaces with their labels now; the pause compares the label of the pane's
    // live workspace with the one this seat's launch gives (`pause.ts`, `waitingProblem`).
    workspaces: () => sources.workspaces?.(session) ?? null,
    seatStates: () => readState(dir).sessions[session]?.seats ?? null,
    workspacePanes: launch.workspacePanes ? (session, workspace) => launch.workspacePanes!(session, workspace) : undefined,
    classify: (name, pane, cli) => readScreen(cli, launch.paneText(name, pane) ?? undefined).kind,
    paneText: (session, pane) => launch.paneText(session, pane),
    shellBack: (session, pane) => launch.shellBack?.(session, pane) ?? null,
    processInfo: (session, pane) => launch.processInfo?.(session, pane) ?? null,
    sleep: sources.sleep ?? launch.sleep,
    now: () => now().getTime(),
    allow(name) {
      if (sources.machine) {
        const problem = crossed(sources.machine(root));
        if (problem) return problem;
      }
      const seat = team.seats.find((item) => item.name === name);
      if (!seat || !ceilings) return null;
      return overCeiling(ceilings, running, seat);
    },
    record(name, patch) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[name] ?? { stage: patch.stage };
        // The CLI the seat was launched with: `down` needs it when the file no longer names the seat.
        const cli = team.seats.find((seat) => seat.name === name)?.cli;
        let start_cwd = prior.start_cwd;
        if (!start_cwd && patch.createdWorkspace && verifiedLobby) start_cwd = verifiedLobby;
        // `waiting: null` removes the field alone; anything else written replaces it.
        const { waiting: written, ...rest } = patch;
        const seat: SeatState = { ...prior, ...rest, ...(cli ? { cli } : {}), ...(start_cwd ? { start_cwd } : {}) };
        if (written === null) delete seat.waiting;
        else if (written) seat.waiting = written;
        current.seats[name] = seat;
      });
    },
    running(name) {
      if (running.some((item) => item.name === name)) return;
      const seat = team.seats.find((item) => item.name === name);
      if (seat) running.push({ name, vendor: seat.vendor, temporary: false });
    },
    drop(name) {
      updateState(dir, (file) => {
        const seats = file.sessions[session]?.seats;
        if (seats) delete seats[name];
      });
    },
    // What is not a record — a skip line, a session failure, the watch's sentence — is cleaned
    // here with the same function the records use: no escape sequence or bidi override reaches
    // the terminal from a file's word, a screen's word or a folder's name.
    say: (line) => io.stderr(plainText(line)),
    progress: (seat, state) => records.progress(seat, state),
    final: (seat, record) => records.final(seat, record),
    detail: (line) => records.detail(line),
    cliVersion(cli) {
      const profile = profileFor(cli);
      if (!profile || !sources.doctor) return null;
      return sources.doctor.version(profile.binary);
    },
    log: (who, what) => logLine(dir, 'up', callerLabel(caller), `${who}: ${what}`, now()),
    /**
     * §3/§4: what happens to a seat this run finds at a dialog. The owner at a terminal is
     * asked, in `pause.ts`, with `o`/`s`/`q`; an owner whose stdin is not a terminal never
     * reads it — the workspace is closed without input and the record says so (§2).
     */
    dialog:
      caller.kind === 'owner'
        ? { mode: 'prompt', run: (input: PauseInput) => runPause(input, pauseHostFor(input)) }
        : { mode: 'close-no-terminal' },
    clearWaiting(name) {
      updateState(dir, (file) => {
        const seatState = file.sessions[session]?.seats[name];
        if (seatState) delete seatState.waiting;
      });
    },
    seatLock: (name) => acquireSeatLock(dir, session, name),
  };

  // §2: the owner's terminal. Only a run that may prompt builds a reader, and a read only
  // happens from the pause's own key(): a caller whose stdin is not a terminal never gets here
  // (`dialog` is `close-no-terminal` for it), and a dry run returns before the host is built.
  const terminal = sources.terminal ? sources.terminal() : terminalReader(process.stdin, processSignals);
  const seatCli = (name: string) => team.seats.find((item) => item.name === name)?.cli ?? '';
  /** The pause's host for one seat: this run's state, seat lock, screen reads and writer. Every
   *  line it says goes through the writer, and nothing here sends a key or a text into a pane. */
  const pauseHostFor = (input: PauseInput): PauseHost => ({
    lock: () => acquireSeatLock(dir, session, input.seat),
    state: () => readState(dir).sessions[session]?.seats[input.seat],
    write(change) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        const prior = current.seats[input.seat] ?? { stage: 'launched' as const };
        const record = change(prior.waiting);
        // The process identity is read here, at the moment the record is written, in the same
        // write: `[o]`, `[s]`, a resumed `up` and `team answer` all refuse a pane whose
        // process is gone or replaced.
        const identity = launchedIdentity(launch.processInfo?.(session, input.pane) ?? null);
        current.seats[input.seat] = {
          ...prior,
          waiting: record,
          pane: input.pane,
          ...(input.workspace ? { workspace: input.workspace } : {}),
          ...(identity ? { launched: identity } : {}),
        };
      });
    },
    clear() {
      updateState(dir, (file) => {
        const seatState = file.sessions[session]?.seats[input.seat];
        if (seatState) delete seatState.waiting;
      });
    },
    drop: () => host.drop(input.seat),
    screen: () => readScreen(seatCli(input.seat), launch.paneText(session, input.pane) ?? undefined).kind,
    process: () => launch.processInfo?.(session, input.pane) ?? null,
    agents: () => launch.agents(session),
    workspaces: () => sources.workspaces?.(session) ?? null,
    workspacePanes: (workspace) => launch.workspacePanes?.(session, workspace) ?? null,
    seats: () => readState(dir).sessions[session]?.seats ?? null,
    focus: () => launch.focus?.(session, input.pane) ?? false,
    close: (workspace) => launch.closeWorkspace(session, workspace),
    record: (label) => records.waiting(input.seat, label),
    prompt: (line) => records.prompt(line),
    drain: () => terminal.drain(),
    // A line beside the record: the writer owns the line's termination, and the cleaning of
    // every string it writes once the records slice's round lands.
    say: (line) => records.prompt(line.endsWith('\n') ? line.slice(0, -1) : line),
    entering: (classification) => host.log(input.seat, recordWhat({ kind: 'waiting for owner', classification })),
    key: (ms) => terminal.key(ms),
    sleep: (ms) => (sources.sleep ?? launch.sleep)(ms),
    now: () => now().getTime(),
    idleTimeout: profileFor(seatCli(input.seat))?.idleTimeout ?? 90,
    polled: trustPolicy(team) === 'coordinator' && input.classification === 'trust',
  });

  const report = await executePlan(plan, session, host);
  const afterwards = readState(dir).sessions[session]?.seats ?? {};
  const pending = team.seats.filter((seat) => {
    if (seat.stopped || !profileFor(seat.cli)) return false;
    return afterwards[seat.name]?.stage !== 'ready';
  });
  // A seat the plan left behind (a repair it would not close, a dialog it timed out at) is a
  // seat left short of ready even when its state still says ready: `held` makes that exit 1.
  // exit: up.ready
  // exit: up.pending
  // exit: up.server
  // exit: up.watch
  return pending.length || report.serverFailed || report.watchFailed || report.held ? 1 : 0;
}
