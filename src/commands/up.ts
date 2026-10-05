import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalDifferencesOf, budgetsInForceOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { migrationText } from '../file/migrate.ts';
import { isLegacyTrust, isMigratedTrust } from '../file/paths.ts';
import { relaunchRepair } from '../file/sections/lead.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import {
  agentList,
  agentStatus,
  agentRename,
  paneForeground,
  paneProcesses,
  paneRead,
  paneRun,
  paneShellBack,
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
  type PaneProcesses,
  type SessionState,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { launchLineFinding } from '../launch/line.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
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
  workspaces?(session: string): { id: string }[] | null;
  home: string;
  getuid?(): number;
  fs?: FsReader;
  doctor?: DoctorSources;
  machine?(root: string): Machine;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
  alive?(pid: number): boolean;
  watchCommand?(session: string): string;
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
  workspaces: { id: string }[] | null,
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
  if (recorded.stage === 'ready') {
    if (named || onPane) return { ...planned, stage: 'ready', ...restartNote(team, seat.name, recorded, home) };
    return planned;
  }
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

// What only a relaunch repairs, for a ready seat this `up` leaves as it is: a process team it
// never recorded (a launch from before identities were), or a start outside the machine lobby
// (an old release's start). The skip line says what does repair it; both repairs relaunch the
// seat — one seat at a time, or the whole team (for a coordinator or operator, only the whole team).
function restartNote(
  team: Pick<TeamFile, 'coordinator' | 'operator'>,
  name: string,
  recorded: SeatState,
  home: string,
): { restartNote: string } | Record<string, never> {
  const fix = relaunchRepair(team, name, 'plain');
  if (!recorded.launched) return { restartNote: `a relaunch records its process: ${fix}` };
  if (recorded.start_cwd && recorded.start_cwd !== lobbyDir(home)) {
    return { restartNote: `a relaunch moves it into the lobby: ${fix}` };
  }
  return {};
}

export async function runUp(argv: string[], io: Io, sources: UpSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['dry-run']);
  if (args.error || args.rest.length) {
    io.stderr(`team up: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: up.invocation
    return 2;
  }
  const dry = args.flags.has('dry-run');
  const loaded = loadTeamFile(io.cwd, { ...(args.values.file ? { file: args.values.file } : {}), home: sources.home });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team up: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
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
  if (!isOwner(caller)) {
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
      const unknown = agents.filter((agent) => !agent.name || !Object.hasOwn(recorded, agent.name));
      if (unknown.length) {
        refusals.push(
          `session ${session} has ${unknown.length} agent${unknown.length === 1 ? '' : 's'} this file's state doesn't record: \`up\` never touches a running team`,
        );
      }
    }
  }

  const lobby = lobbyDir(sources.home);
  if (!team.trust || team.trust.length === 0 || isLegacyTrust(team.trust)) {
    // The block names every entry the next `up` will require, computed from the file, so one
    // edit takes the file past validation. The same block is what `doctor` and `add` print.
    refusals.push(
      `the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\n${migrationText(team, root, sources.home)}`,
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
    if (line?.level === 'note') (dry ? io.stdout : io.stderr)(`  note ${seat.name}: ${line.why}\n`);
    const launchProblem = line?.level === 'miss' ? { launchProblem: line.why } : {};
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
    for (const refusal of [...new Set(refusals)]) io.stdout(`! up would refuse: ${refusal}\n`);
    io.stdout(formatPlan(plan));
    // exit: up.dry-run
    return 0;
  }
  if (refusals.length) {
    for (const refusal of [...new Set(refusals)]) io.stderr(`team up: ${refusal}\n`);
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
    stopSession: () => false,
    kill: () => false,
    agentPanes: launch.agentPanes,
    agentList: launch.agents,
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
        current.seats[name] = { ...prior, ...patch, ...(cli ? { cli } : {}), ...(start_cwd ? { start_cwd } : {}) };
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
    say: (line) => io.stdout(line),
    log: (who, what) => logLine(dir, 'up', describeCaller(caller), `${who}: ${what}`, now()),
  };

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
