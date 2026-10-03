import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner, mayChangeTeam } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { markStopped, takeOut } from '../file/lines.ts';
import { paneForeground } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { executePlan } from '../launch/execute.ts';
import type { Host } from '../launch/execute.ts';
import { downPlan, type DownSeat } from '../launch/plan.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, readState, updateState, withLock } from '../state.ts';
import { paneStillRunning, realSources as downSources, stateOf, type DownSources } from './down.ts';

export type RemoveSources = DownSources & {
  /** Foreground process names in the pane, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: RemoveSources = {
  ...downSources,
  foreground: (session, pane) => paneForeground(pane, aim(session)),
};

const USAGE = 'Usage: team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]\n';

const LEFT: Record<Exclude<DownSeat['state'], 'free'>, string> = {
  working: 'is working; left as it is',
  blocked: 'is blocked at a prompt, which team never answers',
  unknown: 'shows a screen the profile does not recognise; left as it is',
  unsent: 'holds unsent text in its input box; left as it is',
};

export const remove: Command = (argv, io) => runRemove(argv, io, realSources);
export default remove;

export async function runRemove(argv: string[], io: Io, sources: RemoveSources = realSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['keep', 'abandon']);
  if (args.error || args.rest.length !== 1) {
    io.stderr(`team remove: ${args.error ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : 'a seat name is required')}\n${USAGE}`);
    return 2;
  }
  const name = args.rest[0] ?? '';
  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) io.stderr(`team remove: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    return 2;
  }
  const caller = callerOf(io);
  if (args.values.file && !isOwner(caller)) {
    io.stderr(`team remove: --file is the owner's, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`);
    return 1;
  }
  if (!mayChangeTeam(caller, loaded.team)) {
    io.stderr(`team remove: only the owner, the coordinator or the operator runs it; this call is ${describeCaller(caller)}\n`);
    return 1;
  }
  const { team, path } = loaded;
  const session = args.values.session ?? team.session;
  if (session === 'default') {
    io.stderr('team remove: session can\'t be "default", herdr\'s own session\n');
    return 1;
  }
  const abandon = args.flags.has('abandon');
  if (abandon && caller.kind !== 'owner') {
    io.stderr('team remove: only the owner abandons a seat, from a terminal outside herdr\n');
    return 1;
  }
  if ((name === team.coordinator || name === team.operator) && caller.kind !== 'owner') {
    io.stderr(`team remove: only the owner removes the coordinator's or the operator's seat; this call is ${describeCaller(caller)}\n`);
    return 1;
  }

  const dir = dirname(path);
  const recorded = readState(dir).sessions[session]?.seats[name];
  const declared = team.seats.find((seat) => seat.name === name);
  if (!declared && !recorded) {
    io.stderr(`team remove: the team has no seat ${JSON.stringify(name)}\n`);
    return 1;
  }
  const temporary = recorded?.temporary;
  if (args.flags.has('keep') && temporary) {
    io.stderr('team remove: a temporary seat is not in the file; there is nothing to keep\n');
    return 1;
  }

  const live = sources.sessionRunning(session);
  if (live === null) {
    io.stderr('team remove: herdr doesn\'t answer; nothing was changed\n');
    return 1;
  }
  const agents = live ? sources.agents(session) : [];
  if (agents === null) {
    io.stderr(`team remove: session ${session} runs, and its agents can't be read; nothing was changed\n`);
    return 1;
  }
  const agent = agents.find((item) => item.name === name);
  const cli = declared?.cli ?? team.seats.find((seat) => seat.name === temporary?.like)?.cli ?? '';
  if (agent) {
    const screen = sources.screen(session, agent.pane, cli);
    const where = stateOf(agent.status, screen);
    if (where !== 'free' && !abandon) {
      io.stderr(`team remove: ${name} ${LEFT[where]}\n`);
      return 1;
    }
    if (!profileFor(cli) && !abandon) {
      io.stderr(`team remove: no launch profile for \`${cli}\`; left as it is\n`);
      return 1;
    }
    const stopped = await stopRunning({
      io, dir, session, sources, logCommand: 'remove', caller: describeCaller(caller),
      seat: { name, cli, pane: agent.pane, workspace: agent.workspace, state: where === 'free' ? 'free' : where },
      abandon: abandon && where !== 'free',
    });
    if (!stopped) return 1;
  }

  if (!temporary) {
    withLock(dir, () => {
      const text = readFileSync(path, 'utf8');
      const next = args.flags.has('keep') ? markStopped(text, name) : takeOut(text, name);
      if (next !== text) writeFileSync(path, next);
    });
  }
  if (!agent && recorded) {
    updateState(dir, (file) => {
      const seats = file.sessions[session]?.seats;
      if (seats) delete seats[name];
    });
  }
  const who = describeCaller(caller);
  const what = temporary ? `removed temporary ${name}` : args.flags.has('keep') ? `stopped ${name}` : `removed ${name}`;
  logLine(dir, 'remove', who, what, sources.now());
  io.stdout(`${what}\n`);
  return 0;
}

/** Types the exit, waits for the shell, and closes the workspace. False leaves the seat as it is. */
export async function stopRunning(input: {
  io: Io;
  dir: string;
  session: string;
  seat: DownSeat;
  abandon: boolean;
  sources: RemoveSources;
  logCommand: string;
  caller: string;
}): Promise<boolean> {
  const launch = input.sources.launch;
  if (!launch) {
    input.io.stderr('team remove: this call has no way to reach herdr\n');
    return false;
  }
  const { seat, session, sources } = input;
  let stopped = false;
  const steps = downPlan({
    session,
    seats: [seat],
    extra: 1,
    watchPid: null,
    keep: [],
    abandon: input.abandon,
  }).filter((step) => step.kind !== 'skip');
  const host: Host = {
    startServer: () => false,
    sessionUp: () => true,
    createWorkspace: () => null,
    paneRun: () => false,
    typeLine(sessionName, pane, text) {
      const look = () => sources.screen(sessionName, pane, seat.cli).kind;
      const resting = () => {
        const status = sources.status(sessionName, pane);
        return status === 'idle' || status === 'done';
      };
      if (!resting() || look() !== 'idle') return false;
      if (!launch.typeText(sessionName, pane, text)) return false;
      const after = look();
      if (!resting() || (after !== 'idle' && after !== 'unsent')) return false;
      return launch.pressEnter(sessionName, pane);
    },
    renameAgent: () => false,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    kill: () => false,
    agentPanes(sessionName) {
      const listed = launch.agentPanes(sessionName);
      if (!listed) return null;
      const names = profileFor(seat.cli)?.processNames;
      if (!names) return listed;
      return listed.filter((pane) => paneStillRunning(sources.foreground(sessionName, pane), names));
    },
    classify: () => 'unknown',
    sleep: sources.sleep ?? launch.sleep,
    now: () => sources.now().getTime(),
    allow: () => null,
    record() {},
    running() {},
    drop(dropped) {
      if (dropped !== seat.name) return;
      stopped = true;
      updateState(input.dir, (file) => {
        const seats = (file.sessions[session] ??= emptySession()).seats;
        delete seats[dropped];
      });
    },
    say: (line) => input.io.stdout(line),
    log: (who, what) => logLine(input.dir, input.logCommand, input.caller, `${who}: ${what}`, sources.now()),
  };
  await executePlan(steps, session, host);
  return stopped;
}
