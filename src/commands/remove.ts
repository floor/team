import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { recordSeatDigestOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { describeCaller, isOwner, judgeCallerIn, judgeCallerOf, mayChangeTeamVerdict, noPaneRefusal, standingOf } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { markStopped, takeOut } from '../file/lines.ts';
import type { Problem } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { writeTeamFile } from '../file/write.ts';
import { paneForeground } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { executePlan } from '../launch/execute.ts';
import type { Host } from '../launch/execute.ts';
import { downPlan, type DownSeat } from '../launch/plan.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, readState, updateState, withLock } from '../state.ts';
import { paneStillRunning, realSources as downSources, stateOf, type DownSources } from './down.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { removeRulesFile } from '../launch/rules-file.ts';

export type RemoveSources = DownSources & {
  /** Foreground process names in the pane, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Approval store home. The real command uses the owner's home. */
  home?: string;
  // The approval store's one read, done before anything is stopped or written and reused by the
  // amending branch, overridable so a test can count it or swap the record after the read.
  standing?(root: string): Standing;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: RemoveSources = {
  ...downSources,
  foreground: (session, pane) => paneForeground(pane, aim(session)),
};

export const USAGE = 'Usage: team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]\n';

const LEFT: Record<Exclude<DownSeat['state'], 'free'>, string> = {
  working: 'is working; left as it is',
  blocked: 'is blocked at a prompt, which team never answers',
  unknown: 'shows a screen the profile does not recognise; left as it is',
  unsent: 'holds unsent text in its input box; left as it is',
};

export const remove: Command = (argv, io) => runRemove(argv, io, realSources);
export default remove;

/** The file edit `remove` would write, or null when that edit is valid or changes nothing. */
function editProblems(path: string, name: string, keep: boolean): Problem[] | null {
  const text = readFileSync(path, 'utf8');
  const next = keep ? markStopped(text, name) : takeOut(text, name);
  if (next === text) return null;
  const parsed = validateTeamFile(next);
  return parsed.ok ? null : parsed.errors;
}

export async function runRemove(argv: string[], io: Io, sources: RemoveSources = realSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['keep', 'abandon']);
  if (args.error || args.rest.length !== 1) {
    io.stderr(`team remove: ${args.error ?? (args.rest.length ? `unexpected "${args.rest[0]}"` : 'a seat name is required')}\n${USAGE}`);
    // exit: remove.invocation
    return 2;
  }
  const name = args.rest[0] ?? '';
  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) io.stderr(`team remove: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    // exit: remove.not-a-repo
    // exit: remove.file
    // exit: remove.file-invalid
    return 2;
  }
  const { team, path, root } = loaded;
  const dir = dirname(path);
  // The gate judges the caller placed in the session this command asks about — the proof its pane
  // is that session's. With no `--session` the session judged is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team up
  // --session <other>`) — never one a non-owner chose. The refusal names the caller's own
  // placement, exactly as main described it.
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team);
  const { caller, shown } = judged;
  const session = judged.session;
  if (args.values.file && !isOwner(caller)) {
    io.stderr(`team remove: --file is the owner's, from a terminal outside herdr; this call is ${describeCaller(shown)}\n`);
    // exit: remove.file-owner
    return 1;
  }
  // The session a seat is judged in is the team file's; --session is the owner's to choose, so a
  // non-owner can't aim the check at a session where its pane holds the seat's name.
  if (args.values.session && !isOwner(caller)) {
    io.stderr(`team remove: --session is the owner's, from a terminal outside herdr; this call is ${describeCaller(shown)}\n`);
    // exit: remove.session-owner
    return 1;
  }
  const verdict = mayChangeTeamVerdict(caller, team, standingOf(dir, session, caller));
  if (verdict.kind === 'no-pane') {
    io.stderr(`team remove: ${noPaneRefusal(verdict.name)}\n`);
    // exit: remove.no-pane
    return 1;
  }
  if (verdict.kind === 'refused') {
    io.stderr(`team remove: only the owner, the coordinator or the operator runs it; this call is ${describeCaller(shown)}\n`);
    // exit: remove.caller
    return 1;
  }
  if (session === 'default') {
    io.stderr('team remove: session can\'t be "default", herdr\'s own session\n');
    // exit: remove.default-session
    return 1;
  }
  const abandon = args.flags.has('abandon');
  if (abandon && caller.kind !== 'owner') {
    io.stderr('team remove: only the owner abandons a seat, from a terminal outside herdr\n');
    // exit: remove.abandon
    return 1;
  }
  if ((name === team.coordinator || name === team.operator) && caller.kind !== 'owner') {
    io.stderr(`team remove: only the owner removes the coordinator's or the operator's seat; this call is ${describeCaller(caller)}\n`);
    // exit: remove.coordinator
    return 1;
  }

  const recorded = readState(dir).sessions[session]?.seats[name];
  const declared = team.seats.find((seat) => seat.name === name);
  if (!declared && !recorded) {
    io.stderr(`team remove: the team has no seat ${JSON.stringify(name)}\n`);
    // exit: remove.no-seat
    return 1;
  }
  const temporary = recorded?.temporary;
  if (args.flags.has('keep') && temporary) {
    io.stderr('team remove: a temporary seat is not in the file; there is nothing to keep\n');
    // exit: remove.keep-temporary
    return 1;
  }

  const live = sources.sessionRunning(session);
  if (live === null) {
    io.stderr('team remove: herdr doesn\'t answer; nothing was changed\n');
    // exit: remove.herdr
    return 1;
  }
  const agents = live ? sources.agents(session) : [];
  if (agents === null) {
    io.stderr(`team remove: session ${session} runs, and its agents can't be read; nothing was changed\n`);
    // exit: remove.agents
    return 1;
  }
  const agent = agents.find((item) => item.name === name);
  const cli = declared?.cli ?? team.seats.find((seat) => seat.name === temporary?.like)?.cli ?? '';
  if (agent) {
    const screen = sources.screen(session, agent.pane, cli);
    const where = stateOf(agent.status, screen);
    if (where !== 'free' && !abandon) {
      io.stderr(`team remove: ${name} ${LEFT[where]}\n`);
      // exit: remove.busy
      return 1;
    }
    if (!profileFor(cli) && !abandon) {
      io.stderr(`team remove: no launch profile for \`${cli}\`; left as it is\n`);
      // exit: remove.no-profile
      return 1;
    }
  }

  // An edit that will not validate is refused before the seat is stopped. Stopping first would
  // end the live session and then report that nothing was written.
  if (!temporary) {
    const ahead = editProblems(path, name, args.flags.has('keep'));
    if (ahead) {
      for (const problem of ahead) {
        io.stderr(`team remove: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
      }
      // exit: remove.edit
      return 2;
    }
  }

  // No approval in force: nothing is stopped and nothing is written for a team the owner never
  // approved. Read after the read-only refusals above, which name a more specific problem, and
  // before the seat is stopped or the file is edited.
  const home = sources.home ?? homedir();
  const standing = sources.standing?.(root) ?? approvalStanding(root, home);
  if (standing.kind !== 'verified') {
    io.stderr(`team remove: ${notInForce(standing)}\n`);
    // exit: remove.never-approved
    return 1;
  }

  if (agent) {
    const screen = sources.screen(session, agent.pane, cli);
    const where = stateOf(agent.status, screen);
    const stopped = await stopRunning({
      io, dir, session, sources, logCommand: 'remove', caller: describeCaller(caller),
      seat: { name, cli, pane: agent.pane, workspace: agent.workspace, state: where === 'free' ? 'free' : where },
      abandon: abandon && where !== 'free',
    });
    // exit: remove.no-launch
    // exit: remove.stop-failed
    if (!stopped) return 1;
  }

  let kept: string | null = null;
  if (!temporary) {
    const refused = withLock(dir, () => {
      const text = readFileSync(path, 'utf8');
      const next = args.flags.has('keep') ? markStopped(text, name) : takeOut(text, name);
      if (next === text) return null;
      const wrote = writeTeamFile(path, next);
      if (!wrote.ok) return wrote.errors;
      if (args.flags.has('keep')) kept = next;
      return null;
    });
    if (refused) {
      for (const problem of refused) {
        io.stderr(`team remove: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
      }
      // exit: remove.locked
      return 2;
    }
  }
  if (kept !== null) {
    const parsed = validateTeamFile(kept);
    if (parsed.ok) recordSeatDigestOf(standing, parsed.team, root, name, home);
  }
  if (!agent && recorded) {
    updateState(dir, (file) => {
      const seats = file.sessions[session]?.seats;
      if (seats) delete seats[name];
    });
  }
  // A temporary seat's rules file goes with the seat: nothing of it is left in the state
  // folder. A declared seat's stays — a stopped seat comes back to its own file. No home set
  // is a test that stands in for no store at all. The remover builds the path itself, from the
  // approval in force and the seat's name, and walks the writer's checked chain.
  if (temporary && sources.home) {
    removeRulesFile(sources.standing?.(root) ?? approvalStanding(root, sources.home), name, root, sources.home);
  }
  const who = describeCaller(caller);
  const what = temporary ? `removed temporary ${name}` : args.flags.has('keep') ? `stopped ${name}` : `removed ${name}`;
  logLine(dir, 'remove', who, what, sources.now());
  io.stdout(`${what}\n`);
  // exit: remove.removed
  // exit: remove.kept
  // exit: remove.temporary
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
      const names = profileFor(seat.cli)?.processNames ?? [];
      const live = () => reportedLiveAgent(sources.foreground(sessionName, pane), names);
      if (!live()) return 'no-agent';
      const look = () => sources.screen(sessionName, pane, seat.cli).kind;
      const resting = () => {
        const status = sources.status(sessionName, pane);
        return status === 'idle' || status === 'done';
      };
      if (!resting() || look() !== 'idle') return false;
      if (!launch.typeText(sessionName, pane, text)) return false;
      if (!live()) return 'no-agent';
      // As in `down`: only a box that reads back as exactly the typed text gets the Enter.
      if (!resting() || !boxHoldsText(seat.cli, text, sources.screenText(sessionName, pane, seat.cli))) return false;
      return launch.pressEnter(sessionName, pane);
    },
    renameAgent: () => false,
    closeWorkspace: launch.closeWorkspace,
    stopSession: () => false,
    kill: () => false,
    agentPanes(sessionName) {
      const listed = launch.agentPanes(sessionName);
      if (!listed) return null;
      // A pane back at its shell is no longer the seat. The wait keeps an unreadable list
      // (`paneStillRunning`); the watch's quota read asks the other way (`reportedLiveAgent`).
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
