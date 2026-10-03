import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, mayChangeTeam } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { agentList, sessionRunning, type HerdrAgent } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { downPlan, formatPlan, type DownSeat } from '../launch/plan.ts';
import { readState } from '../state.ts';

// What `down` reads from outside the file, so tests can stand in for it.
export type DownSources = {
  sessionRunning(session: string): boolean | null;
  agents(session: string): HerdrAgent[] | null;
  alive(pid: number): boolean;
};

export const realSources: DownSources = {
  sessionRunning,
  agents: (session) => agentList(session === 'default' ? undefined : session),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

const USAGE = 'Usage: team down --dry-run [--session <name>] [--file <path>]\n';

export const down: Command = (argv, io) => runDown(argv, io, realSources);
export default down;

// herdr's status alone: it reports a seat waiting at a permission prompt as idle, so the real
// `down` also reads the screen before it types anything.
function stateOf(status: string): DownSeat['state'] {
  if (status === 'idle' || status === 'done') return 'free';
  if (status === 'working' || status === 'blocked') return status;
  return 'unknown';
}

export async function runDown(argv: string[], io: Io, sources: DownSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['dry-run']);
  if (args.error || args.rest.length) {
    io.stderr(`team down: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2;
  }
  if (!args.flags.has('dry-run')) {
    io.stderr(`team down: this version stops nothing; \`--dry-run\` prints every command it would run\n${USAGE}`);
    return 1;
  }
  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team down: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  const { team } = loaded;
  const session = args.values.session ?? team.session;

  const running = sources.sessionRunning(session);
  if (running === null) {
    io.stderr("team down: herdr doesn't answer; is it installed and running?\n");
    return 2;
  }
  if (!running) {
    io.stdout(`session ${session} is not running: nothing to stop\ndry run: nothing was run\n`);
    return 0;
  }
  const agents = sources.agents(session);
  if (agents === null) {
    io.stderr(`team down: the agents of session ${session} can't be read\n`);
    return 2;
  }

  const caller = callerOf(io, session === 'default' ? undefined : session);
  if (!mayChangeTeam(caller, team)) {
    io.stdout(
      `! down would refuse: only the owner, the coordinator or the operator stops the team; this call is ${describeCaller(caller)}\n`,
    );
  }

  const state = readState(dirname(loaded.path)).sessions[session];
  const known = new Set([...team.seats.map((seat) => seat.name), ...Object.keys(state?.seats ?? {})]);
  const cliOf = new Map(team.seats.map((seat) => [seat.name, seat.cli]));
  const seats: DownSeat[] = [];
  let extra = 0;
  for (const agent of agents) {
    if (!agent.name || !known.has(agent.name)) {
      extra++;
      continue;
    }
    const like = state?.seats[agent.name]?.temporary?.like;
    seats.push({
      name: agent.name,
      cli: cliOf.get(agent.name) ?? (like ? cliOf.get(like) : undefined) ?? 'unknown',
      pane: agent.pane,
      workspace: agent.workspace,
      state: stateOf(agent.status),
    });
  }

  const watch = state?.watch;
  io.stdout(
    formatPlan(
      downPlan({
        session,
        seats,
        extra,
        watchPid: watch && sources.alive(watch.pid) ? watch.pid : null,
        // A seat's call leaves the coordinator's and the operator's seats, and so the session.
        keep: caller.kind === 'seat' ? [team.coordinator, team.operator] : [],
      }),
    ).replace(
      /dry run: nothing was run\n$/,
      "free is read from herdr's status here; `down` also reads each screen before it types\ndry run: nothing was run\n",
    ),
  );
  return 0;
}
