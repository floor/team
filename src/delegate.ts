import { approvalDifferencesOf, notInForce } from './approve/approval.ts';
import { callerOf, describeCaller, readAncestors, type Caller, type CallerSources } from './caller.ts';
import type { Delegate, DelegateCommand } from './delegate-types.ts';
import { DELEGATE_COMMANDS } from './delegate-types.ts';
import type { TeamFile } from './file/types.ts';
import { validateTeamFile } from './file/validate.ts';
import { agentList, paneRootPid, type HerdrAgent } from './herdr.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { readState, type State } from './state.ts';
import { approvalStanding, type Standing } from './store/store.ts';

/**
 * A delegated run, decided and not yet done. `passed` names the approved pane the caller
 * stood in. `refused` is what the command prints after `team <command>: `, with no newline;
 * the id is the exit id.
 */
export type DelegateVerdict =
  | { kind: 'passed'; pane: string }
  | { kind: 'refused'; id: string; text: string };

/**
 * The reads a test replaces. Each one left out is the real read: the approval standing and
 * its stored copy for `root`, the state in `dir`, the agent list herdr gives for a session.
 * Placement is not here. It is `io`, asked about a session, the same way every other command
 * places its caller.
 */
export type DelegateSources = {
  standing?: (root: string) => Standing;
  /** Null when the approved copy cannot be read. */
  approvedCopy?: (root: string) => string | null;
  /** Null when the state cannot be read. */
  state?: (dir: string) => State | null;
  /** Null when herdr doesn't answer for that session. */
  agents?: (session: string) => HerdrAgent[] | null;
  /**
   * Placement sources for one session, when a test does not put them on `io`. The real
   * path uses `io.callerSources`.
   */
  callerSources?: (session: string | undefined) => CallerSources;
};

/** The refusal `add` gives a delegate whose add would edit the file or the approval. */
export const ADD_DELEGATE_EDIT: { id: 'add.delegate-edit'; text: string } = {
  id: 'add.delegate-edit',
  text: 'the approved delegate cannot change the file or the approval; the owner adds a missing or stopped seat',
};

const PREFLIGHT = ['delegate-approval', 'delegate-approved-copy', 'delegate-drift', 'delegate-evidence', 'delegate-placement'] as const;

/** Every exit id the gate and `ADD_DELEGATE_EDIT` define. The command files record them. */
export const DELEGATE_EXIT_IDS: readonly string[] = [
  ...DELEGATE_COMMANDS.flatMap((command) => [
    ...PREFLIGHT.map((suffix) => `${command}.${suffix}`),
    `${command}.delegate`,
    `${command}.delegate-command`,
    `${command}.delegate-flag`,
  ]),
  ADD_DELEGATE_EDIT.id,
];

// The flag order is the order a refusal names when several are present. `restore` and
// clearing `stopped` are not flags: `add` reports those with `ADD_DELEGATE_EDIT`.
const PROHIBITED: Record<DelegateCommand, readonly string[]> = {
  up: ['session', 'file'],
  down: ['abandon', 'session', 'file'],
  add: ['temporary', 'like', 'until', 'worktree', 'session', 'file'],
  remove: ['keep', 'abandon', 'session', 'file'],
};

const ANCESTORS = 'its parent processes can\'t be read to the top';
const HERDR = 'it runs under herdr, and herdr doesn\'t answer';
const ROOTS = 'it runs under herdr, and no pane root can be read';

/**
 * The audit line, written through `logLine` so it is the same cleaning and the same
 * `<time> command [caller] what` shape as every other line. A delegated run calls this
 * exactly when it passes the gate and proceeds to effects.
 */
export function logDelegated(dir: string, pane: string, command: DelegateCommand, now?: Date): void {
  logLine(dir, 'delegate', 'delegate', `${pane} ${command}`, now);
}

/**
 * Whether this caller may run `command` for the live file. The command calls it only after
 * its ordinary caller rule has refused, and only when `team.delegates` is set. It reads that
 * file and nothing remembered: no earlier valid copy and no unverified approval is consulted.
 * It decides and stops. It does not print, write, or launch.
 *
 * An earlier refusal wins. Any approval difference refuses, and that includes a reorder of
 * the delegates list or of a command list: both are part of the canonical value.
 */
export function delegateGate(input: {
  command: DelegateCommand;
  team: TeamFile;
  root: string;
  dir: string;
  flags: readonly string[];
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>;
  sources?: DelegateSources;
}): DelegateVerdict {
  const { command, team, root, dir, flags } = input;
  const sources = input.sources ?? {};
  const refuse = (suffix: string, text: string): DelegateVerdict => ({ kind: 'refused', id: `${command}.${suffix}`, text });

  const standing = (sources.standing ?? approvalStanding)(root);
  if (standing.kind !== 'verified') {
    return refuse('delegate-approval', `delegation needs a verified approval: ${notInForce(standing)}`);
  }

  const copy = sources.approvedCopy ? sources.approvedCopy(root) : standing.record.file;
  if (copy === null || validated(copy) === null) {
    return refuse('delegate-approved-copy', 'delegation needs a readable approved copy: run `team approve`');
  }

  const differences = approvalDifferencesOf(standing, team);
  if (differences.length > 0) {
    return refuse(
      'delegate-drift',
      `delegation needs the approved file: the file is not the approved one (${differences.join('; ')}): run \`team approve\``,
    );
  }

  const entries = team.delegates ?? [];
  const io = sources.callerSources ? { ...input.io, callerSources: sources.callerSources } : input.io;
  const evidence = evidenceOf(team, dir, io, sources, entries);
  if (!evidence.ok) return refuse('delegate-evidence', `delegation cannot verify its placement or seats: ${evidence.reason}`);
  if (entries.some((entry) => collides(team, entry, evidence.state, evidence.agents))) {
    return refuse('delegate-placement', 'the approved delegate must be an external non-seat pane');
  }

  const found = findEntry(entries, io);
  if (found.kind === 'evidence') return refuse('delegate-evidence', `delegation cannot verify its placement or seats: ${found.reason}`);
  if (found.kind === 'none') return refuse('delegate', nonDelegate(command, describeCaller(found.caller)));
  if (!found.entry.commands.includes(command)) {
    const list = found.entry.commands.join(', ');
    return refuse('delegate-command', `the approved delegate ${found.entry.pane} may not run \`${command}\`; its approved commands are ${list}`);
  }
  const flag = PROHIBITED[command].find((name) => flags.includes(name));
  if (flag !== undefined) return refuse('delegate-flag', `--${flag} is the owner's; the approved delegate cannot use it`);
  return { kind: 'passed', pane: found.entry.pane };
}

const NON_DELEGATE: Record<DelegateCommand, (caller: string) => string> = {
  up: (caller) => `only the owner or the approved delegate runs \`up\`; this call is ${caller}`,
  down: (caller) => `only the owner, the coordinator, the operator or the approved delegate stops the team; this call is ${caller}`,
  add: (caller) => `only the owner, the coordinator, the operator or the approved delegate runs it; this call is ${caller}`,
  remove: (caller) => `only the owner, the coordinator, the operator or the approved delegate runs it; this call is ${caller}`,
};

function nonDelegate(command: DelegateCommand, caller: string): string {
  return NON_DELEGATE[command](caller);
}

function validated(text: string): TeamFile | null {
  try {
    const result = validateTeamFile(text);
    return result.ok ? result.team : null;
  } catch {
    return null;
  }
}

function splitPane(pane: string): { session: string; id: string } | null {
  const slash = pane.indexOf('/');
  if (slash <= 0 || slash !== pane.lastIndexOf('/') || slash === pane.length - 1) return null;
  if (/\s/.test(pane)) return null;
  return { session: pane.slice(0, slash), id: pane.slice(slash + 1) };
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'the evidence can\'t be read';
}

type Evidence =
  | { ok: true; state: State; agents: HerdrAgent[] }
  | { ok: false; reason: string };

/**
 * The first unreadable read, in the order a refusal names it: the caller's ancestors, herdr
 * for a delegate's session and for the team's session, then the state. A null from herdr is
 * its own refusal, distinct from a caller who is simply somewhere else. The state and the
 * team's agent list come back with the answer, so the collision check reads them once.
 */
function evidenceOf(
  team: TeamFile,
  dir: string,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  sources: DelegateSources,
  entries: readonly Delegate[],
): Evidence {
  if (io.caller === undefined) {
    const sessions = sessionsOf(entries);
    const asked = sessions.length > 0 ? sessions : [undefined];
    for (const session of asked) {
      const placement = placementSources(io, sources, session);
      const reason = placementReason(placement, entryPane(entries, session));
      if (reason !== null) return { ok: false, reason };
    }
  }
  let listed: HerdrAgent[] | null;
  try {
    listed = (sources.agents ?? agentList)(team.session);
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  if (listed === null) return { ok: false, reason: 'herdr doesn\'t answer' };
  try {
    const state = (sources.state ?? readState)(dir);
    if (state === null) return { ok: false, reason: 'the state can\'t be read' };
    return { ok: true, state, agents: listed };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

function sessionsOf(entries: readonly Delegate[]): string[] {
  const sessions: string[] = [];
  for (const entry of entries) {
    const split = splitPane(entry.pane);
    if (split && !sessions.includes(split.session)) sessions.push(split.session);
  }
  return sessions;
}

function entryPane(entries: readonly Delegate[], session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  return entries.find((entry) => splitPane(entry.pane)?.session === session)?.pane;
}

function placementSources(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  sources: DelegateSources,
  session: string | undefined,
): CallerSources {
  const factory = sources.callerSources ?? io.callerSources;
  if (factory) return factory(session);
  return {
    ancestors: () => readAncestors(),
    agents: () => (session === undefined ? [] : (sources.agents ?? agentList)(session)),
    paneRootPid: (pane) => paneRootPid(pane, session),
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  };
}

function placementReason(sources: CallerSources, pane: string | undefined): string | null {
  let ancestors;
  try {
    ancestors = sources.ancestors();
  } catch (error) {
    return reasonOf(error);
  }
  if (!ancestors?.length) return ANCESTORS;
  if (!ancestors.some((process) => process.name === 'herdr')) return null;
  let agents: HerdrAgent[] | null;
  try {
    agents = sources.agents();
  } catch (error) {
    return reasonOf(error);
  }
  if (agents === null) return HERDR;
  const root = (id: string): number | null => {
    try {
      return sources.paneRootPid(id);
    } catch {
      return null;
    }
  };
  if (agents.length > 0 && agents.every((agent) => root(agent.pane) === null)) return ROOTS;
  const id = pane === undefined ? undefined : splitPane(pane)?.id;
  if (id !== undefined && agents.some((agent) => agent.pane === id) && root(id) === null) return ROOTS;
  return null;
}

function collides(team: TeamFile, entry: Delegate, state: State, agents: readonly HerdrAgent[]): boolean {
  const split = splitPane(entry.pane);
  if (split === null || split.session === team.session) return true;
  const names = new Set<string>([team.coordinator, team.operator, ...team.seats.map((seat) => seat.name)]);
  const panes: string[] = [];
  for (const agent of agents) {
    if (agent.name !== null && names.has(agent.name)) panes.push(agent.pane);
  }
  for (const session of Object.values(state.sessions)) {
    for (const seat of Object.values(session.seats ?? {})) {
      if (seat.pane) panes.push(seat.pane);
    }
  }
  return panes.some((pane) => `${team.session}/${pane}` === entry.pane);
}

type Found =
  | { kind: 'match'; entry: Delegate }
  | { kind: 'none'; caller: Caller }
  | { kind: 'evidence'; reason: string };

/**
 * The entry whose `<session>/<pane id>` is the caller's. The agent name is not compared: a
 * rename of the agent in the approved pane still matches, and a pane renamed to that agent's
 * name does not. The caller is placed in each entry's session, because a pane id only means
 * something inside the session that lists it.
 */
function findEntry(entries: readonly Delegate[], io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>): Found {
  let shown: Caller | undefined;
  for (const entry of entries) {
    const split = splitPane(entry.pane);
    if (split === null) continue;
    const placed = callerOf(io, split.session);
    const reason = evidenceCaller(placed);
    if (reason !== null) return { kind: 'evidence', reason };
    if (placed.kind === 'seat' && placed.session === split.session && placed.pane === split.id) return { kind: 'match', entry };
    if (shown === undefined || (shown.kind !== 'seat' && placed.kind === 'seat')) shown = placed;
  }
  return { kind: 'none', caller: shown ?? callerOf(io) };
}

function evidenceCaller(caller: Caller): string | null {
  if (caller.kind !== 'unplaced') return null;
  if (caller.reason === ANCESTORS || caller.reason === HERDR || caller.reason === ROOTS) return caller.reason;
  return null;
}
