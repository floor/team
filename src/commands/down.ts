import { readArgs } from '../args.ts';
import { callerOf, describeCaller, mayChangeTeam, type Caller } from '../caller.ts';
import { currentTeam } from '../file/current.ts';
import {
  agentList,
  agentStatus,
  paneForeground,
  paneRead,
  sessionDelete,
  sessionRunning,
  pressEnter,
  sessionStop,
  typeText,
  workspaceClose,
  type HerdrAgent,
} from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import type { Host } from '../launch/execute.ts';
import { executePlan } from '../launch/execute.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { downPlan, formatPlan, type DownSeat } from '../launch/plan.ts';
import { profileFor } from '../profiles/index.ts';
import { logLine } from '../log.ts';
import { emptySession, readState, updateState } from '../state.ts';
import { readScreen, type Screen } from '../watch/screen.ts';

// What `down` reads from outside the file, so tests can stand in for it.
export type DownSources = {
  sessionRunning(session: string): boolean | null;
  agents(session: string): HerdrAgent[] | null;
  alive(pid: number): boolean;
  /** Herdr's status is not enough: a permission prompt is reported as idle. */
  screen(session: string, pane: string, cli: string): Screen;
  /** Herdr's own status for the pane. The Enter waits for idle or done. */
  status(session: string, pane: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  now(): Date;
  sleep?(ms: number): Promise<void>;
  // Present on the shipped command. A dry run never calls it.
  launch?: DownLaunch;
};

export type DownLaunch = {
  typeText(session: string, pane: string, text: string): boolean;
  pressEnter(session: string, pane: string): boolean;
  agentPanes(session: string): string[] | null;
  closeWorkspace(session: string, workspace: string): boolean;
  stopSession(session: string): boolean;
  /** Clears the session this run stopped, so a later `up` starts from the beginning. */
  deleteSession(session: string): boolean;
  kill(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

const realLaunch: DownLaunch = {
  typeText: (session, pane, text) => typeText(pane, text, aim(session)),
  pressEnter: (session, pane) => pressEnter(pane, aim(session)),
  agentPanes(session) {
    const agents = agentList(aim(session));
    return agents === null ? null : agents.map((agent) => agent.pane);
  },
  closeWorkspace: (session, workspace) => workspaceClose(workspace, aim(session)),
  stopSession: sessionStop,
  deleteSession: sessionDelete,
  kill(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export const realSources: DownSources = {
  sessionRunning,
  agents: (session) => agentList(aim(session)),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  screen(session, pane, cli) {
    return readScreen(cli, paneRead(pane, 200, aim(session)) ?? undefined);
  },
  status: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  launch: realLaunch,
};

/** How long `--wait` gives a working seat, in seconds. */
export const WAIT_SECONDS = 120;

export const USAGE = 'Usage: team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>]\n';

export const down: Command = (argv, io) => runDown(argv, io, realSources);
export default down;

// Free only when herdr says idle or done and the screen is an empty idle prompt. A permission
// prompt is idle to herdr, and typing `/exit` there would answer it.
// Herdr keeps a pane after the CLI exits, so the pane id staying listed is not "still there".
// The seat has left when no foreground process is its CLI. An unreadable list keeps the wait.
export function paneStillRunning(foreground: readonly string[] | null, processNames: readonly string[]): boolean {
  if (!foreground) return true;
  return foreground.some((name) => processNames.includes(name));
}

export function stateOf(status: string, screen: Screen): DownSeat['state'] {
  if (screen.kind === 'unsent') return 'unsent';
  if (screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question') return 'blocked';
  // A screen showing a running turn is working even when herdr's status has not caught up:
  // `--wait` waits for it, and it is never typed into.
  if (screen.kind === 'working') return 'working';
  if (screen.kind === 'unknown') return 'unknown';
  if (status === 'idle' || status === 'done') return 'free';
  if (status === 'working' || status === 'blocked') return status;
  return 'unknown';
}

export async function runDown(argv: string[], io: Io, sources: DownSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['dry-run', 'wait', 'abandon']);
  if (args.error || args.rest.length) {
    io.stderr(`team down: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2;
  }
  const dry = args.flags.has('dry-run');
  const current = currentTeam(io.cwd, args.values.file, sources.now());
  if (!current.ok) {
    for (const problem of current.errors) {
      io.stderr(`team down: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  if (current.notice) io.stdout(`${current.notice}\n`);
  const { team, dir } = current;
  const session = args.values.session ?? team.session;

  const running = sources.sessionRunning(session);
  if (running === null) {
    io.stderr("team down: herdr doesn't answer; is it installed and running?\n");
    return 2;
  }
  if (!running) {
    io.stdout(`session ${session} is not running: nothing to stop${dry ? '\ndry run: nothing was run' : ''}\n`);
    return 0;
  }
  let agents = sources.agents(session);
  if (agents === null) {
    io.stderr(`team down: the agents of session ${session} can't be read\n`);
    return 2;
  }

  const caller = callerOf(io, session === 'default' ? undefined : session);
  const refusals: string[] = [];
  if (!mayChangeTeam(caller, team)) {
    refusals.push(
      `only the owner, the coordinator or the operator stops the team; this call is ${describeCaller(caller)}`,
    );
  }
  const abandon = args.flags.has('abandon');
  if (abandon && !callerOwns(caller)) {
    refusals.push('only the owner abandons a team, from a terminal outside herdr');
  }

  const state = readState(dir).sessions[session];
  const known = new Set([...team.seats.map((seat) => seat.name), ...Object.keys(state?.seats ?? {})]);
  const cliOf = new Map(team.seats.map((seat) => [seat.name, seat.cli]));
  // The CLI a running seat was launched with: the file's for the seats it still names, the
  // state's for the rest, so a seat the file renamed is still stopped. A temporary seat falls
  // back to the seat it is like. A state too old to say leaves the seat to its owner, named
  // in the plan.
  const cliFor = (name: string): string => {
    const recorded = state?.seats[name];
    const like = recorded?.temporary?.like;
    return cliOf.get(name) ?? recorded?.cli ?? (like ? cliOf.get(like) ?? state?.seats[like]?.cli : undefined) ?? 'unknown';
  };

  if (!dry && args.flags.has('wait') && refusals.length === 0) {
    const deadline = sources.now().getTime() + WAIT_SECONDS * 1000;
    const sleep = sources.sleep ?? sources.launch?.sleep;
    while (sleep && sources.now().getTime() < deadline) {
      const waiting = agents.some((agent) => {
        if (!agent.name) return false;
        return stateOf(agent.status, sources.screen(session, agent.pane, cliFor(agent.name))) === 'working';
      });
      if (!waiting) break;
      const before = sources.now().getTime();
      await sleep(2000);
      if (sources.now().getTime() <= before) break;
      const again = sources.agents(session);
      if (again === null) break;
      agents = again;
    }
  }

  const seats: DownSeat[] = [];
  let extra = 0;
  for (const agent of agents) {
    if (!agent.name || !known.has(agent.name)) {
      extra++;
      continue;
    }
    const cli = cliFor(agent.name);
    seats.push({
      name: agent.name,
      cli,
      pane: agent.pane,
      workspace: agent.workspace,
      state: stateOf(agent.status, sources.screen(session, agent.pane, cli)),
    });
  }

  const watch = state?.watch;
  const plan = downPlan({
    session,
    seats,
    extra,
    watchPid: watch && sources.alive(watch.pid) ? watch.pid : null,
    keep: caller.kind === 'seat' ? [team.coordinator, team.operator] : [],
    abandon: abandon && callerOwns(caller),
  });

  if (dry) {
    for (const refusal of refusals) io.stdout(`! down would refuse: ${refusal}\n`);
    io.stdout(formatPlan(plan));
    return 0;
  }
  if (refusals.length) {
    for (const refusal of refusals) io.stderr(`team down: ${refusal}\n`);
    return 1;
  }
  const launch = sources.launch;
  if (!launch) {
    io.stderr('team down: this call has no way to reach herdr\n');
    return 1;
  }

  const now = () => sources.now();
  const host: Host = {
    startServer: () => false,
    sessionUp: () => true,
    createWorkspace: () => null,
    paneRun: () => false,
    typeLine(sessionName, pane, text) {
      // Free was decided when the plan was built. Look again, and once more between the text and
      // the Enter: a prompt that appeared would take the key, as the watch's nudge does. Herdr's
      // status is asked both times; Enter waits until it is idle or done and the screen is idle
      // or holding unsent text.
      const cli = seats.find((seat) => seat.pane === pane)?.cli ?? '';
      const names = profileFor(cli)?.processNames ?? [];
      const live = () => reportedLiveAgent(sources.foreground(sessionName, pane), names);
      if (!live()) return 'no-agent';
      const look = () => sources.screen(sessionName, pane, cli).kind;
      const resting = () => {
        const status = sources.status(sessionName, pane);
        return status === 'idle' || status === 'done';
      };
      if (!resting() || look() !== 'idle') return false;
      if (!launch.typeText(sessionName, pane, text)) return false;
      if (!live()) return 'no-agent';
      const after = look();
      if (!resting() || (after !== 'idle' && after !== 'unsent')) return false;
      return launch.pressEnter(sessionName, pane);
    },
    renameAgent: () => false,
    closeWorkspace: launch.closeWorkspace,
    stopSession: launch.stopSession,
    // Only the session this run has itself just stopped, and only once herdr agrees it is no
    // longer running: anything else — still running, or herdr silent — is left to its owner, with
    // the command the line in `executePlan` names. `up` never deletes a session at all.
    deleteSession(name) {
      return sources.sessionRunning(name) === false && launch.deleteSession(name);
    },
    kill: launch.kill,
    agentPanes(sessionName) {
      const listed = launch.agentPanes(sessionName);
      if (!listed) return null;
      // A pane back at its shell is no longer the seat. `gone` then finishes and the workspace
      // closes. The wait keeps an unreadable list (`paneStillRunning`); the watch's quota read
      // asks the other way — `reportedLiveAgent`, a figure only where the CLI was seen.
      return listed.filter((pane) => {
        const cli = seats.find((seat) => seat.pane === pane)?.cli;
        const names = cli ? profileFor(cli)?.processNames : undefined;
        if (!names) return true;
        return paneStillRunning(sources.foreground(sessionName, pane), names);
      });
    },
    classify: () => 'unknown',
    sleep: sources.sleep ?? launch.sleep,
    now: () => now().getTime(),
    allow: () => null,
    record() {},
    running() {},
    drop(name) {
      updateState(dir, (file) => {
        const seatsOf = (file.sessions[session] ??= emptySession()).seats;
        delete seatsOf[name];
      });
    },
    say: (line) => io.stdout(line),
    log: (who, what) => logLine(dir, 'down', describeCaller(caller), `${who}: ${what}`, now()),
  };
  const report = await executePlan(plan, session, host);
  return report.held ? 1 : 0;
}

function callerOwns(caller: Caller): boolean {
  return caller.kind === 'owner';
}
