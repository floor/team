import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerOf, describeCaller, fileOwnerRefusal, isOwner, judgeCallerIn, mayChangeTeamVerdict, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller, type Caller } from '../caller.ts';
import { delegateGate, logDelegated, type DelegateSources, type DelegateVerdict } from '../delegate.ts';
import { currentTeam, type Current } from '../file/current.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
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
import { boxHoldsText } from '../launch/deliver.ts';
import { removeRulesFile } from '../launch/rules-file.ts';
import { approvalStanding } from '../store/store.ts';
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
  /** The pane's raw text, for reading the input box back before any Enter. */
  screenText(session: string, pane: string, cli: string): string | undefined;
  /** Herdr's own status for the pane. The Enter waits for idle or done. */
  status(session: string, pane: string): string | null;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  now(): Date;
  sleep?(ms: number): Promise<void>;
  /** Approval store home. The real command uses the owner's home. */
  home?: string;
  // Present on the shipped command. A dry run never calls it.
  launch?: DownLaunch;
  /** The delegate gate. Tests hand in a verdict; the shipped command asks the real one. */
  gate?: typeof delegateGate;
  /** The gate's own fakes: the approval standing, the approved copy, state, herdr, placement. */
  delegate?: DelegateSources;
  /** The audit line a delegated run leaves. Tests record it; the shipped command writes it. */
  audit?: typeof logDelegated;
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
  screenText: (session, pane) => paneRead(pane, 200, aim(session)) ?? undefined,
  status: (session, pane) => agentStatus(pane, aim(session)),
  foreground: (session, pane) => paneForeground(pane, aim(session)),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home: homedir(),
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
  if (screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question' || screen.kind === 'vendor notice') return 'blocked';
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
    // exit: down.invocation
    return 2;
  }
  const dry = args.flags.has('dry-run');
  const refusals: string[] = [];

  // --- the delegate branch -----------------------------------------------------------------
  // The gate is asked at most once, and only where the ordinary rule has just refused: a caller
  // the ordinary rule accepts never reaches it, and the owner — never a delegate — asks nothing.
  // The live file is read directly, never `currentTeam`'s remembered copy and never `last_valid`,
  // and this command acts on that same read when the branch decides the run: a delegated run
  // never calls `currentTeam` at all. A file that does not load carries no delegate, and the
  // ordinary path keeps its own fallback and its own words.
  //
  // `granted` is the approved pane a `passed` verdict names. A refusal the gate can only give
  // *after* it placed the caller — an unlisted command, a prohibited flag — means the caller is
  // that pane too: its run plans as a delegate's though the refusal stops it.
  const gate = sources.gate ?? delegateGate;
  const flags = [...args.flags, ...Object.keys(args.values)];
  let asked = false;
  let verdict: DelegateVerdict | undefined;
  let granted: string | undefined;
  let placed = false;
  let liveRead = false;
  let live: LiveFile | undefined;
  const liveFile = (): LiveFile | undefined => {
    if (!liveRead) {
      liveRead = true;
      live = liveTeam(io, sources.home);
    }
    return live;
  };
  const decide = (): DelegateVerdict | undefined => {
    if (asked) return verdict;
    asked = true;
    const file = liveFile();
    if (file === undefined || file.team.delegates === null) return undefined;
    verdict = gate({
      command: 'down',
      team: file.team,
      root: file.root,
      dir: file.dir,
      flags,
      io: { env: io.env, stdinIsTTY: io.stdinIsTTY, caller: io.caller, callerSources: io.callerSources },
      ...(sources.delegate ? { sources: sources.delegate } : {}),
    });
    if (verdict.kind === 'passed') granted = verdict.pane;
    else if (verdict.id === 'down.delegate-command' || verdict.id === 'down.delegate-flag') placed = true;
    return verdict;
  };
  // The caller is the pane the gate placed: the run is the delegate's, whatever the verdict.
  const branching = (): boolean => granted !== undefined || placed;

  // The `--file` check is the walk's too, and it runs before `currentTeam` reads that file or
  // writes beside it: a non-owner aiming `--file` must not make this command read and validate
  // another project's team file, nor leave its `last_valid` in that project's state. The one
  // place every command whose `--file` is the owner's decides it is `fileOwnerRefusal` (caller.ts).
  // A delegate is refused here too, and its refusal is the gate's: every flag is the owner's,
  // this one included, so the flagged path is never read and the run goes on as the delegate's.
  // Any other answer — the gate didn't place this caller, or the file carries no delegate — is
  // refused here, byte for byte as today.
  const fileRefusal = fileOwnerRefusal(io, args.values.file);
  if (fileRefusal !== undefined) {
    const said = decide();
    if (said?.kind === 'refused' && placed) {
      refusals.push(said.text);
    } else {
      io.stderr(`team down: ${fileRefusal}\n`);
      // exit: down.file-owner
      return 1;
    }
  }
  // The owner is a terminal outside herdr, and the walk alone decides that: a non-owner aiming
  // `--session` is refused here, before `currentTeam` writes anything and before the flag's
  // session is read — no agent list, no pane root, no `last_valid`, no log line. The dry run
  // refuses the same way: the plan it would print is that session's, which is not its to aim.
  // (A seat cannot be named in this refusal: placing it would read a session, and that is what
  // must not happen yet.) A delegate's `--session` is the same case as its `--file`.
  if (args.values.session !== undefined && !branching()) {
    const walked = walkCaller(io);
    if (!isOwner(walked)) {
      const said = decide();
      if (said?.kind === 'refused' && placed) {
        refusals.push(said.text);
      } else {
        io.stderr(`team down: ${sessionOwnerRefusal(walked)}\n`);
        // exit: down.session-owner
        return 1;
      }
    }
  }
  // Both flags are dropped once the branch has decided the run: the gate has refused them, and a
  // delegated run judges the file's own session, as any delegated `down` does.
  const file = branching() ? undefined : args.values.file;
  const sessionFlag = branching() ? undefined : args.values.session;

  // The run's file. The owner's path is today's exactly: `currentTeam`, which remembers a valid
  // file and falls back to the last copy that validated. A caller that is not the owner may be a
  // delegate's, and a delegated run reads the live file directly — never `currentTeam`, never
  // `last_valid` — so a live file that carries `delegates` is the run's file, whether the gate
  // passes that caller or refuses it. A file that does not load carries no delegate: today's
  // path, with today's fallback and today's words, decides.
  const owner = isOwner(walkCaller(io));
  const liveNow = owner ? undefined : liveFile();
  const current: Current = liveNow !== undefined && liveNow.team.delegates !== null
    ? { ok: true, team: liveNow.team, root: liveNow.root, dir: liveNow.dir, warnings: [] }
    : currentTeam(io.cwd, file, sources.now(), sources.home);
  if (!current.ok) {
    for (const problem of current.errors) {
      io.stderr(`team down: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: down.not-a-repo
    // exit: down.file
    // exit: down.file-invalid
    return 2;
  }
  if (current.notice) io.stdout(`${current.notice}\n`);
  const { team, dir, root } = current;
  // With no `--session` the session this run judges and stops is the caller's own placement: the
  // file's session first, then a session the state records this caller's pane in (`team up
  // --session <other>`) — never one a non-owner chose, and the plan then names that session. The
  // flag keeps aiming the run, for the owner alone. A delegated run stops the whole team, in the
  // session the file names: its caller is a pane outside that team, and no placement of it may
  // move the run onto another session — its own included.
  const judged = branching()
    ? { caller: callerOf(io), session: team.session }
    : sessionFlag !== undefined
      ? { caller: callerOf(io, sessionFlag === 'default' ? undefined : sessionFlag), session: sessionFlag }
      : judgeCallerIn(io, dir, team);
  let caller = judged.caller;
  let session = judged.session;

  // The ordinary caller rule, for the session the caller's own placement named. It is what decides
  // whether the gate is asked at all: a caller the rule accepts never enters the delegate branch,
  // and a run it accepts keeps its own session, its own plan and today's bytes exactly.
  const rule = mayChangeTeamVerdict(caller, team, standingOf(dir, session, caller));
  // A gate answer can move a run onto another session: the delegate branch always stops the team
  // the file names, whatever session the caller's placement pointed at. The two differ only for a
  // caller placed in a session the state holds (`team up --session <other>`), and the owner is
  // never one of those. So the gate is asked here, before the checks below, and a placed caller's
  // run is checked — and stopped — in the file's session, not in the one it happens to sit in.
  // Asking before those checks is the point: an idle session of the caller's own must not wave
  // through a run that stops another, and a refusal that places nobody leaves the run on its own
  // session, where the checks below still come first: an idle one returns idle, as it would have.
  if (!owner && judged.session !== team.session && rule.kind !== 'ok') {
    const said = decide();
    if (said?.kind === 'refused' && placed) refusals.push(said.text);
    if (branching()) {
      caller = callerOf(io);
      session = team.session;
    }
  }

  const running = sources.sessionRunning(session);
  if (running === null) {
    io.stderr("team down: herdr doesn't answer; is it installed and running?\n");
    // exit: down.herdr
    return 2;
  }
  if (!running) {
    io.stdout(`session ${session} is not running: nothing to stop${dry ? '\ndry run: nothing was run' : ''}\n`);
    // exit: down.idle
    return 0;
  }
  let agents = sources.agents(session);
  if (agents === null) {
    io.stderr(`team down: the agents of session ${session} can't be read\n`);
    // exit: down.agents
    return 2;
  }

  if (rule.kind !== 'ok' && !branching()) {
    // The ordinary rule has refused, and only now is the gate asked. With no delegate in the live
    // file nothing changes. A refusal takes the ordinary refusal's place, in the same place and at
    // the same exit statuses: a real run stops on it, a dry run says what it would refuse and
    // prints the plan. A pass lets the run go on as the delegate's.
    const said = decide();
    if (said === undefined) {
      if (rule.kind === 'no-pane') {
        refusals.push(noPaneRefusal(rule.name));
      } else if (rule.kind === 'another-pane') {
        refusals.push(anotherPaneRefusal(rule.name, rule.recordedPane));
      } else {
        refusals.push(
          `only the owner, the coordinator or the operator stops the team; this call is ${describeCaller(caller)}`,
        );
      }
    } else if (said.kind === 'refused') {
      refusals.push(said.text);
    }
  }
  // A delegated run never abandons: `--abandon` is the gate's refusal, and the plan holds every
  // seat, coordinator and operator included, exactly as the owner's own `down` does. A gate that
  // has answered is the run's only refusal: today's abandon line stays out of the way of its own.
  const abandon = args.flags.has('abandon') && granted === undefined;
  if (abandon && !callerOwns(caller) && verdict === undefined) {
    refusals.push('only the owner abandons a team, from a terminal outside herdr');
  }
  const branchRun = branching();

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
    // A delegated run stops the whole team: no seat is kept back, the coordinator and the
    // operator included. The delegate sits outside the session, so it never stops itself.
    keep: !branchRun && caller.kind === 'seat' ? [team.coordinator, team.operator] : [],
    abandon: abandon && callerOwns(caller),
  });

  if (dry) {
    for (const refusal of refusals) io.stdout(`! down would refuse: ${refusal}\n`);
    io.stdout(formatPlan(plan));
    // exit: down.dry-run
    return 0;
  }
  if (refusals.length) {
    for (const refusal of refusals) io.stderr(`team down: ${refusal}\n`);
    // exit: down.caller
    // exit: down.abandon
    // exit: down.no-pane
    // exit: down.another-pane
    // exit: down.delegate
    // exit: down.delegate-approval
    // exit: down.delegate-approved-copy
    // exit: down.delegate-drift
    // exit: down.delegate-evidence
    // exit: down.delegate-placement
    // exit: down.delegate-command
    // exit: down.delegate-flag
    return 1;
  }
  const launch = sources.launch;
  if (!launch) {
    io.stderr('team down: this call has no way to reach herdr\n');
    // exit: down.no-launch
    return 1;
  }
  // The audit line goes in exactly when the delegate's run passes its gate and proceeds to
  // effects — never on a dry run (returned above), never on an already-idle `down` (which
  // returns at its own check, before any caller rule), never when a refusal held the run, and
  // never when herdr is out of reach.
  if (granted !== undefined) (sources.audit ?? logDelegated)(dir, granted, 'down', sources.now());

  const now = () => sources.now();
  const host: Host = {
    startServer: () => false,
    sessionUp: () => true,
    createWorkspace: () => null,
    paneRun: () => false,
    typeLine(sessionName, pane, text) {
      // Free was decided when the plan was built. Look again, and once more between the text and
      // the Enter: a prompt that appeared would take the key, as the watch's nudge does. Herdr's
      // status is asked both times; the Enter waits until it is idle or done and the box reads
      // back as exactly the typed text.
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
      // An idle screen after the typing is the text not rendered, and unsent text alone is not
      // this exit's: only a box that reads back as the typed text gets the Enter.
      if (!resting() || !boxHoldsText(cli, text, sources.screenText(sessionName, pane, cli))) return false;
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
      // A temporary seat's rules file goes with the seat, as `remove` takes one; a declared
      // seat's stays, ready for the next `up`. No home set is a test with no store at all. The
      // remover builds the path itself, from the approval in force and the seat's name.
      if (state?.seats[name]?.temporary && sources.home) {
        removeRulesFile(approvalStanding(root, sources.home), name, root, sources.home);
      }
    },
    say: (line) => io.stdout(line),
    log: (who, what) => logLine(dir, 'down', describeCaller(caller), `${who}: ${what}`, now()),
  };
  const report = await executePlan(plan, session, host);
  // exit: down.stopped
  // exit: down.held
  return report.held ? 1 : 0;
}

/** A team file read directly, with the project root and the `.agents` directory beside it. */
type LiveFile = { team: TeamFile; root: string; dir: string };

/**
 * The live team file, read directly: the copy the delegate gate judges and the copy a delegated
 * run acts on. Never `currentTeam`'s remembered copy, never `last_valid` — a file that does not
 * load carries no delegate, and the ordinary path keeps its own fallback and its own words.
 */
function liveTeam(io: Io, home?: string): LiveFile | undefined {
  const loaded = loadTeamFile(io.cwd, home ? { home } : {});
  if (!loaded.ok) return undefined;
  return { team: loaded.team, root: loaded.root, dir: dirname(loaded.path) };
}

function callerOwns(caller: Caller): boolean {
  return caller.kind === 'owner';
}
