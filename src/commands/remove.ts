import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { recordSeatDigestOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, describeCaller, fileOwnerRefusal, isOwner, judgeCallerIn, judgeCallerOf, mayChangeTeamVerdict, noPaneRefusal, sessionOwnerRefusal, standingOf, walkCaller } from '../caller.ts';
import { delegateGate, logDelegated } from '../delegate.ts';
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
import { downPlan, type DownSeat, type LeftState } from '../launch/plan.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { emptySession, readState, updateState, withLock } from '../state.ts';
import { paneStillRunning, realSources as downSources, seatState, typeExit, type DownSources } from './down.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { removeRulesFile } from '../launch/rules-file.ts';
import { acquireRunLock, runLockText } from '../launch/run-lock.ts';

export type RemoveSources = DownSources & {
  /** Foreground process names in the pane, or null when the pane can't be read. */
  foreground(session: string, pane: string): string[] | null;
  /** Approval store home. The real command uses the owner's home. */
  home?: string;
  // The approval store's one read, done before anything is stopped or written and reused by the
  // amending branch, overridable so a test can count it or swap the record after the read.
  standing?(root: string): Standing;
  // The delegate gate, overridable so a test can hand a delegated run its verdict. Absent: the
  // real gate (`src/delegate.ts`).
  delegateGate?: typeof delegateGate;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: RemoveSources = {
  ...downSources,
  foreground: (session, pane) => paneForeground(pane, aim(session)),
};

export const USAGE = 'Usage: team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>]\n';

/** The gate's refusal as this command prints it: the verdict's own sentence behind the prefix.
 *  Both delegate branches print it — the caller rule's below and the owner-only flags' — so the
 *  exit ids sit at one site. */
function delegateRefused(io: { stderr(text: string): void }, verdict: { text: string }): number {
  io.stderr(`team remove: ${verdict.text}\n`);
  // exit: remove.delegate-approval
  // exit: remove.delegate-approved-copy
  // exit: remove.delegate-drift
  // exit: remove.delegate-evidence
  // exit: remove.delegate-placement
  // exit: remove.delegate
  // exit: remove.delegate-command
  // exit: remove.delegate-flag
  return 1;
}

const LEFT: Record<LeftState, string> = {
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
  // The `--file` check is the walk's, and it runs before that file is read: a non-owner aiming
  // `--file` must not make this command read and validate another project's team file, nor leave
  // its `last_valid` in that project's state. The one place every command whose `--file` is the owner's
  // decides it is `fileOwnerRefusal` (caller.ts).
  //
  // A `delegates` section hands these owner-only flags to the gate as well: a non-owner aiming
  // either is still refused before the flagged file or the flag's session is read — never the
  // walk's sentence but the gate's verdict, which names the flag for the approved delegate and
  // the caller for anyone else. The eligibility that asks is the default live file's alone, so
  // the flagged file is not read at all; with no `delegates` section there, today's refusal
  // stands, byte for byte.
  const walked = args.values.session !== undefined ? walkCaller(io) : undefined;
  const flagRefusal = fileOwnerRefusal(io, args.values.file)
    ?? (walked !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) {
    const named = loadTeamFile(io.cwd, { ...(sources.home ? { home: sources.home } : {}) });
    if (named.ok && named.team.delegates) {
      const flagged = (sources.delegateGate ?? delegateGate)({
        command: 'remove',
        team: named.team,
        root: named.root,
        dir: dirname(named.path),
        flags: [...args.flags, ...Object.keys(args.values)],
        io,
      });
      if (flagged.kind === 'refused') return delegateRefused(io, flagged);
    }
    io.stderr(`team remove: ${flagRefusal}\n`);
    // exit: remove.file-owner
    // exit: remove.session-owner
    return 1;
  }
  const loaded = loadTeamFile(io.cwd, { ...(args.values.file ? { file: args.values.file } : {}), ...(sources.home ? { home: sources.home } : {}) });
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
  const verdict = mayChangeTeamVerdict(caller, team, standingOf(dir, session, caller));
  // The delegate branch, tried only when the ordinary rule just refused and the file names a
  // delegate at all: with no `delegates` section every refusal below stays exactly today's, and
  // the gate is never asked. A refused verdict takes the ordinary refusal's place; a passed one
  // sends this run on as the approved delegate's — the gate has by then verified the approval,
  // the approved copy, the drift and the placement, that this caller is the entry's pane, that
  // `remove` is in its list and that no flag of the owner's was passed. The rest of this command
  // is then a delegated run: an ordinary removal of a named seat, never `--keep` (the gate
  // refused it, so nothing re-signs the approval), the coordinator and the operator still
  // refused below, and `logDelegated` attributing it at its effects.
  let delegatePane: string | null = null;
  if (verdict.kind !== 'ok' && team.delegates) {
    const decided = (sources.delegateGate ?? delegateGate)({
      command: 'remove',
      team,
      root,
      dir,
      flags: [...args.flags, ...Object.keys(args.values)],
      io,
    });
    if (decided.kind === 'refused') return delegateRefused(io, decided);
    delegatePane = decided.pane;
  }
  if (verdict.kind === 'no-pane' && delegatePane === null) {
    io.stderr(`team remove: ${noPaneRefusal(verdict.name)}\n`);
    // exit: remove.no-pane
    return 1;
  }
  if (verdict.kind === 'another-pane' && delegatePane === null) {
    io.stderr(`team remove: ${anotherPaneRefusal(verdict.name, verdict.recordedPane)}\n`);
    // exit: remove.another-pane
    return 1;
  }
  if (verdict.kind === 'refused' && delegatePane === null) {
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
    const where = seatState(agent.status, screen, () => sources.shellBack?.(session, agent.pane) ?? null);
    // A box that holds exactly the profile's exit text — an earlier run typed it and never
    // confirmed it — is cleared with the profile's one key inside the stop, and the removal
    // then proceeds as on an empty box. The same box on a CLI with no key is named for the
    // owner instead of refused with the generic unsent line.
    const profile = profileFor(cli);
    const holdsExit = where === 'unsent' && profile !== null
      && boxHoldsText(cli, profile.exit, sources.screenText(session, agent.pane, cli));
    const clearable = holdsExit && profile?.exitClear !== null;
    // An `exited` seat is not refused: its CLI is gone, nothing is asked, and the stop below
    // closes its workspace. Every other not-free seat keeps its refusal.
    if (where !== 'free' && where !== 'exited' && !abandon && !clearable) {
      // The unknown screen is the one a seat can sit on for good: no state ever frees it, and
      // only the owner may abandon it, so the refusal names that way out. The owner gets the
      // command itself; anyone else is told whose it is. A framed exit question already on
      // screen is the same kind of leave: this run did not ask it, and the line names the close.
      const way = where === 'unknown'
        ? caller.kind === 'owner'
          ? ` (team remove ${name} --abandon closes its workspace without typing)`
          : ` (the owner can close it: team remove ${name} --abandon)`
        : '';
      const held = screen.kind === 'exit question'
        ? `sits at its own exit question; left as it is (team remove ${name} --abandon closes it)`
        : where === 'unsent' && holdsExit
          ? `holds this CLI's exit text (${profile?.exit}) unsent in its input box; left as it is (the owner sends it or clears it in its pane)`
          : LEFT[where];
      io.stderr(`team remove: ${name} ${held}${way}\n`);
      // exit: remove.busy
      return 1;
    }
    if (!profile && !abandon) {
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
  // The session mutator lock: this run has effects from here — the delegated audit line, the
  // stop of a running seat below, the file edit and the state drops — and no other session
  // command may interleave its own. Every refusal above is decided first; a `--keep` run never
  // got past the gate. The lock is released on every exit path (`launch/run-lock.ts`).
  const runLock = acquireRunLock(dir, session);
  if ('held' in runLock) {
    io.stderr(`team remove: ${runLockText(runLock.held, session, dir)}\n`);
    // exit: remove.run-lock
    return 1;
  }
  try {
    // The audit line, exactly at the effects boundary: a delegated run that reaches here is
    // committed to its effects — the stop below when the seat runs, the file edit after it. Every
    // refusal came sooner; a `--keep` run never got past the gate.
    if (delegatePane !== null) logDelegated(dir, delegatePane, 'remove', sources.now());

    if (agent) {
      const screen = sources.screen(session, agent.pane, cli);
      const where = seatState(agent.status, screen, () => sources.shellBack?.(session, agent.pane) ?? null);
      const profile = profileFor(cli);
      const exitInBox = where === 'unsent' && profile !== null && profile.exitClear !== null
        && boxHoldsText(cli, profile.exit, sources.screenText(session, agent.pane, cli));
      const stopped = await stopRunning({
        io, dir, session, sources, logCommand: 'remove', caller: describeCaller(caller),
        seat: {
          name, cli, pane: agent.pane, workspace: agent.workspace,
          state: where === 'free' ? 'free' : where,
          ...(exitInBox ? { exitInBox: true } : {}),
          ...(screen.kind === 'exit question' ? { atExitQuestion: true } : {}),
        },
        abandon: abandon && where !== 'free',
        closeUnasked: abandon,
        unasked: `team remove ${name} --abandon closes it`,
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
      // A delegated remove never re-signs the approval: `--keep` is the gate's to refuse, and the
      // signing itself stays the owner's for a delegate whatever reached here.
      if (parsed.ok && delegatePane === null) recordSeatDigestOf(standing, parsed.team, root, name, home);
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
  } finally {
    runLock.release();
  }
}

/** Types the exit, waits for the shell, and closes the workspace. False leaves the seat as it is. */
export async function stopRunning(input: {
  io: Io;
  dir: string;
  session: string;
  seat: DownSeat;
  abandon: boolean;
  /** The owner's `--abandon`: a seat this call asked, whose exit could not be typed or confirmed, is closed. */
  closeUnasked?: boolean;
  /** Named on the line when that seat is left running. */
  unasked?: string;
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
    closeUnasked: input.closeUnasked,
    unasked: input.unasked,
  }).filter((step) => step.kind !== 'skip');
  const host: Host = {
    startServer: () => false,
    sessionUp: () => true,
    createWorkspace: () => null,
    paneRun: () => false,
    async typeLine(sessionName, pane, text) {
      // As in `down`: the whole sequence — the pre-existing box, the typing, the read-back, the
      // Enter, and the clearing key an unconfirmed read-back can send — is `typeExit`'s.
      return typeExit({
        typeText: (line) => launch.typeText(sessionName, pane, line),
        sendKey: (key) => launch.sendKey(sessionName, pane, key),
        pressEnter: () => launch.pressEnter(sessionName, pane),
        screen: () => sources.screenText(sessionName, pane, seat.cli),
        status: () => sources.status(sessionName, pane),
        foreground: () => sources.foreground(sessionName, pane),
        sleep: sources.sleep ?? launch.sleep,
        now: () => sources.now().getTime(),
      }, seat.cli, text);
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
