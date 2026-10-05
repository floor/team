import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalDifferencesOf, budgetsInForceOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { renderSignature } from '../file/signature.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import {
  agentList,
  agentStatus,
  agentRename,
  paneForeground,
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
  type HerdrAgent,
  type SessionState,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { launchLineFinding } from '../launch/line.ts';
import { formatPlan, upPlan, type UpSeat } from '../launch/plan.ts';
import { rulesText } from '../launch/rules.ts';
import { deliverRules } from '../launch/deliver.ts';
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
  paneText(session: string, pane: string): string | null;
  typeText?(session: string, pane: string, text: string): boolean;
  pressEnter?(session: string, pane: string): boolean;
  agentStatus?(session: string, pane: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Whether the pane's foreground program is back to its shell; null when herdr can't tell. */
  shellBack?(session: string, pane: string): boolean | null;
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
  paneText: (session, pane) => paneRead(pane, 200, aim(session)),
  typeText: (session, pane, text) => typeText(pane, text, aim(session)),
  pressEnter: (session, pane) => pressEnter(pane, aim(session)),
  agentStatus: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  shellBack: (session, pane) => paneShellBack(pane, aim(session)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export const realSources: UpSources = {
  sessionRunning,
  sessionState,
  agents: (session) => agentList(aim(session)),
  workspaces: (session) => workspaceList(aim(session)),
  home: homedir(),
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

/** The rules one seat gets at launch, with its own signature lines, as its delivery carries them. */
export function rulesOf(team: TeamFile, seat: Seat): string {
  const { commits, pullRequests } = team.identity.signature;
  const profile = profileFor(seat.cli);
  const delivery = profile && profile.rulesOption !== null ? 'option' : 'message';
  return rulesText(
    {
      coordinator: team.coordinator,
      rules: team.rules,
      signature: {
        commit: renderSignature(commits.template, seat),
        pullRequest: renderSignature(pullRequests.template, seat),
        commitPosition: commits.position,
      },
      workspace: { mode: seat.mode, protected: team.workspace.protected, branch: team.workspace.branch },
    },
    delivery,
  );
}

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
  team: TeamFile,
  seat: Seat,
  recorded: SeatState | undefined,
  agents: readonly HerdrAgent[],
  workspaces: { id: string }[] | null,
  resume: boolean,
): UpSeat {
  const planned: UpSeat = {
    name: seat.name,
    cli: seat.cli,
    launch: seat.launch,
    cwd: seat.cwd,
    label: seat.label,
    stopped: seat.stopped,
    rules: rulesOf(team, seat),
  };
  if (!resume || !recorded || seat.stopped) return planned;
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
    io.stderr(`team up: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: up.invocation
    return 2;
  }
  const dry = args.flags.has('dry-run');
  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
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

  const recorded = readState(dir).sessions[session];
  const workspaces = sources.workspaces?.(session) ?? null;
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
    const planned = seatPlan(team, seat, recorded?.seats[seat.name], agents ?? [], workspaces, state === 'running');
    // A stopped seat, one without a profile, and one already ready are left out of the budget.
    // A seat resumed into a live workspace starts nowhere new, but its reading is still said.
    if (planned.stopped || !profileFor(seat.cli) || planned.stage === 'ready') {
      seats.push(planned);
      continue;
    }
    const placed = planned.stage === undefined || !planned.pane;
    // The seat's own launch line, checked where the seat starts: a `miss` leaves this seat out
    // before its workspace is made, and the other seats go on. A note is told, never refused.
    const doctor = sources.doctor;
    const line = doctor
      ? launchLineFinding(team, seat, root, { onPath: (binary) => doctor.onPath(binary), home: doctor.home })
      : null;
    const launchProblem = line?.level === 'miss' ? { launchProblem: line.why } : {};
    if (!placed) {
      const budget = budgetOf(seat);
      seats.push({ ...planned, ...launchProblem, ...(budget.kind === 'clear' ? {} : { budget }) });
      continue;
    }
    const start = seatStart(team, seat, root);
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
    deliverRules: (session, pane, cli, text, seconds) => deliverRules(cli, text, seconds, {
        screen: () => launch.paneText(session, pane) ?? undefined,
        status: () => launch.agentStatus?.(session, pane) ?? null,
        type: (value) => launch.typeText?.(session, pane, value) ?? false,
        enter: () => launch.pressEnter?.(session, pane) ?? false,
        foreground: () => launch.foreground(session, pane),
        now: () => now().getTime(),
        sleep: sources.sleep ?? launch.sleep,
      }),
    renameAgent: launch.renameAgent,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    kill: () => false,
    agentPanes: launch.agentPanes,
    classify: (name, pane, cli) => readScreen(cli, launch.paneText(name, pane) ?? undefined).kind,
    paneText: (session, pane) => launch.paneText(session, pane),
    shellBack: (session, pane) => launch.shellBack?.(session, pane) ?? null,
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
        current.seats[name] = { ...prior, ...patch, ...(cli ? { cli } : {}) };
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
  // exit: up.ready
  // exit: up.pending
  // exit: up.server
  // exit: up.watch
  return pending.length || report.serverFailed || report.watchFailed ? 1 : 0;
}
