import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { approvalDifferencesOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, callerVerdict, describeCaller, judgeCallerIn, noPaneRefusal, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { canonicalLanding, folderOf, listFolder, lobbyPath } from '../file/landing.ts';
import { loadTeamFile } from '../file/load.ts';
import { renderSignature } from '../file/signature.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { agentList, agentRename, agentStatus, paneForeground, paneForegroundCwd, paneRead, pressEnter, sendKey as herdrSendKey, typeText } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { deliverRules, type Delivery } from '../launch/deliver.ts';
import { rulesText } from '../launch/rules.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { type Profile } from '../profiles/profile.ts';
import { extractFolder, isEligible, keyOf, labelMatches, versionMatches, type TrustRecord } from '../profiles/trust-answer.ts';
import { emptySession, readState, updateState, type SeatState } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { readEnd } from '../watch/end.ts';
import { readScreen } from '../watch/screen.ts';

export const USAGE = 'Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]\n';

const OUTSIDE = 'ask the owner to approve this exact folder and answer through team up';

export type AnswerHost = {
  version(binary: string): string | null;
  agents(session: string): { name: string; pane: string; workspace?: string }[] | null;
  pane(session: string, pane: string): string | undefined;
  sendKey(session: string, pane: string, key: string): boolean;
  rename(session: string, pane: string, name: string): boolean;
  foreground(session: string, pane: string): string[] | null;
  foregroundCwd(session: string, pane: string): string | null;
  list(dir: string): string[] | null;
  status(session: string, pane: string): string | null;
  type(session: string, pane: string, text: string): boolean;
  enter(session: string, pane: string): boolean;
  now(): Date;
  sleep(ms: number): Promise<void>;
  home: string;
  standing(root: string): Standing;
};

export const realHost: AnswerHost = {
  version(binary) {
    try {
      return execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  },
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane, workspace: agent.workspace })) ?? null,
  pane: (session, pane) => paneRead(pane, 40, session) ?? undefined,
  sendKey: (session, pane, key) => herdrSendKey(pane, key, session),
  rename: (session, pane, name) => agentRename(pane, name, session),
  foreground: (session, pane) => paneForeground(pane, session),
  foregroundCwd: (session, pane) => paneForegroundCwd(pane, session),
  list: (dir) => listFolder(dir),
  status: (session, pane) => agentStatus(pane, session),
  type: (session, pane, text) => typeText(pane, text, session),
  enter: (session, pane) => pressEnter(pane, session),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  home: homedir(),
  standing: (root) => approvalStanding(root, homedir()),
};

type Reason = 'caller' | 'policy' | 'state' | 'screen' | 'version' | 'label' | 'folder' | 'action' | 'idle' | 'rule delivery';

type Refusal = { class: Reason; message: string };

type Seen = { record: TrustRecord; version: string; folder: string };

const answer: Command = (argv, io) => runAnswer(argv, io, realHost);
export default answer;

export async function runAnswer(argv: string[], io: Io, host: AnswerHost): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['json']);
  const json = args.flags.has('json');
  const seatName = args.rest[0];
  const dialog = args.rest[1];
  if (args.error || args.rest.length !== 2 || !seatName || dialog !== 'trust') {
    const message = args.error ?? (dialog && dialog !== 'trust' ? `unknown dialog "${dialog}"` : 'a seat and trust are required');
    return usage(io, json, message);
  }

  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, json, message || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  // The gate judges the caller placed in the session this command asks about. With no `--session`
  // the session judged is the caller's own placement: the file's session first, then a session
  // the state records this caller's pane in (`team up --session <other>`) — never one a non-owner
  // chose. The refusal names the caller's own placement, exactly as main described it.
  const judged = args.values.session !== undefined
    ? { caller: callerOf(io, args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const session = judged.session;
  const who = logWho(caller, team);

  const refused = (reason: Refusal): number => {
    logLine(dir, 'answer', who, `${seatName}: refused trust: ${reason.class}`, host.now());
    if (json) io.stdout(`${JSON.stringify({ seat: seatName, dialog: 'trust', status: 'refused', reason: reason.message })}\n`);
    else io.stderr(`${reason.message}\n`);
    // exit: answer.caller
    // exit: answer.no-pane
    // exit: answer.policy
    // exit: answer.session-owner
    // exit: answer.state
    // exit: answer.version
    // exit: answer.screen
    // exit: answer.label
    // exit: answer.folder
    // exit: answer.action
    return 1;
  };

  // The session a seat is judged in is the team file's; --session is the owner's to choose, so a
  // non-owner can't aim the check at a session where its pane holds the seat's name.
  if (args.values.session && caller.kind !== 'owner') {
    return refused({ class: 'caller', message: `team answer: --session is the owner's, from a terminal outside herdr; this call is ${describeCaller(caller)}` });
  }
  const callerProblem = callerProblemOf(caller, team, seatName, standingOf(dir, session, caller));
  if (callerProblem) return refused(callerProblem);
  const standing = host.standing(root);
  if (standing.kind !== 'verified') return refused({ class: 'caller', message: notInForce(standing) });
  const drift = approvalDifferencesOf(standing, team);
  if (drift.length) return refused({ class: 'caller', message: `the file is not the approved one (${drift.join('; ')})` });
  // The trust entries the folder check reads come from the approved copy itself,
  // never from the live file: the drift check above normally makes the two equal,
  // but the check must not depend on that to be right about what was approved.
  const approved = validateTeamFile(standing.record.file);
  if (!approved.ok) return refused({ class: 'caller', message: 'the approved copy of the team file cannot be read' });
  if (team.dialogs.trust !== 'coordinator') return refused({ class: 'policy', message: `${seatName}: use team up and [o]` });

  const lock = acquireSeatLock(dir, session, seatName);
  if (!('release' in lock)) return refused({ class: 'state', message: `${seatName}: another command holds it` });
  try {
    const state = readState(dir).sessions[session] ?? emptySession();
    const recorded = state.seats[seatName];
    const configured = team.seats.find((seat) => seat.name === seatName);
    const temporary = recorded?.temporary;
    if (!configured && !temporary) return refused({ class: 'state', message: `${seatName}: it is not a live seat` });
    if (temporary && expired(root, temporary.until, team, temporary.own_commits === true)) {
      return refused({ class: 'state', message: `${seatName}: it is not a live seat` });
    }
    const agents = host.agents(session);
    const agent = agents?.find((item) => item.name === seatName)
      ?? (recorded?.pane ? agents?.find((item) => item.pane === recorded.pane) : undefined);
    if (!agents || !agent) return refused({ class: 'state', message: `${seatName}: it is not a live seat` });
    const pane = recorded?.pane ?? agent.pane;
    const workspace = agent.workspace ?? recorded?.workspace;
    const waiting = recorded?.waiting;
    if (waiting?.manual === true) return refused({ class: 'state', message: `${seatName}: the owner has the pane open` });
    if (waiting?.state === 'trust-sent-recovery') {
      return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace);
    }
    if (waiting?.state !== 'waiting-owner' || waiting.classification !== 'trust') {
      return refused({ class: 'state', message: `${seatName}: it is not waiting at a trust dialog` });
    }

    const cli = configured?.cli ?? team.seats.find((seat) => seat.name === temporary?.like)?.cli ?? '';
    const profile = profileFor(cli);
    const checked = inspect(seatName, host, session, pane, profile, approved.team.trust, root);
    if ('class' in checked) return refused(checked);
    const again = inspect(seatName, host, session, pane, profile, approved.team.trust, root);
    if ('class' in again) return refused(again);
    if (again.folder !== checked.folder) return refused({ class: 'folder', message: `${seatName}: ${OUTSIDE}` });
    if (again.record.from !== checked.record.from || again.record.to !== checked.record.to || again.record.action !== checked.record.action) {
      return refused({ class: 'version', message: `${seatName}: this version has no trust answer` });
    }
    const key = keyOf(checked.record.action);
    if (!key) {
      return refused({ class: 'action', message: `${seatName}: the recorded key is not one this version sends` });
    }
    // The recovery intent is on disk before the key: a crash between the two leaves a
    // recovery that may never have sent (a retry only observes), never a waiting-owner
    // whose retry sends a second time.
    if (!recordRecovery(dir, session, seatName, {
      state: 'trust-sent-recovery',
      classification: 'trust',
      sentAt: host.now().toISOString(),
      version: checked.version,
      folder: checked.folder,
    }, pane, workspace)) {
      return refused({ class: 'state', message: `${seatName}: its recovery state could not be recorded` });
    }
    let sent = false;
    try {
      sent = host.sendKey(session, pane, key);
    } catch {
      sent = false;
    }
    if (!sent) {
      logLine(dir, 'answer', who, `${seatName}: refused trust: action`, host.now());
      return recovery(io, json, seatName, 'its key could not be sent', `${seatName}: the key could not be sent; recovery required`);
    }
    return await finish(io, json, host, dir, session, who, seatName, team, configured, pane, workspace);
  } finally {
    lock.release();
  }
}

/** The caller class the caller check returned, as the log's bracket. */
function logWho(caller: Caller, team: TeamFile): string {
  if (caller.kind === 'owner') return 'owner';
  if (caller.kind === 'unplaced') return 'unplaced';
  return caller.name === team.coordinator ? 'coordinator' : 'seat';
}

function callerProblemOf(caller: Caller, team: TeamFile, seat: string, at?: SeatStanding): Refusal | null {
  if (caller.kind === 'owner') return null;
  // The coordinator's seat, in the session judged and on its recorded pane; a seat of another
  // session, or one merely renamed, falls through to the refusal below, unchanged.
  const verdict = callerVerdict(caller, team.coordinator, at);
  if (verdict.kind === 'ok') return null;
  if (verdict.kind === 'no-pane') return { class: 'caller', message: `team answer: ${noPaneRefusal(verdict.name)}` };
  if (caller.kind === 'unplaced') return { class: 'caller', message: caller.reason };
  return { class: 'caller', message: `${seat}: only the owner, or the coordinator from its own seat, can answer` };
}

function expired(root: string, until: string, team: TeamFile, own: boolean): boolean {
  const end = readEnd(root, until, team.workspace.base, own);
  if (end.kind === 'result') return end.exists;
  return end.verdict === 'merged';
}

/**
 * One fresh reading of the pane: the record this version answers, or the class that
 * refused. `trust` is the approved copy's own `trust:` list, never the live file's —
 * the folder must be an entry of what the owner approved.
 */
function inspect(
  seat: string,
  host: AnswerHost,
  session: string,
  pane: string,
  profile: Profile | null,
  trust: readonly string[],
  root: string,
): Seen | Refusal {
  const say = (reason: Reason, text: string): Refusal => ({ class: reason, message: `${seat}: ${text}` });
  if (!profile) return say('version', 'this version has no trust answer');
  const printed = host.version(profile.binary);
  const record = printed
    ? profile.answers.find((item) => isEligible(profile.cli, item) && versionMatches(item, printed))
    : undefined;
  if (!printed || !record) return say('version', 'this version has no trust answer');
  const screen = host.pane(session, pane);
  if (readScreen(profile.cli, screen).kind !== 'trust') return say('screen', 'the pane is not the trust dialog');
  if (!labelMatches(record, screen ?? '')) return say('label', 'the trust choice is not the recorded one');
  const shown = extractFolder(record.extract, screen ?? '');
  if (!shown) return say('folder', 'the dialog does not show exactly one folder');
  // `shown` must be the lobby as team writes it, byte for byte, and canonicalise to
  // it — a trailing slash, another case, `//` or `/./` is a different spelling, and
  // the reading that sends less is to refuse it.
  const lobby = canonicalLanding(lobbyPath(host.home));
  if (!lobby) return say('folder', OUTSIDE);
  if (canonicalLanding(shown) !== lobby) return say('folder', OUTSIDE);
  if (shown !== lobby) return say('folder', 'the dialog does not show the lobby as written: the owner answers it through team up');
  // The screen read strips the row's trailing padding, so the last byte of the path it
  // shows is never proof — a boxed row has no visible end. Two other readings, fresh with
  // this one, must say the lobby too: the folder the pane itself reports working in, byte
  // for byte, and the lobby's parent, where a name the lobby's plus whitespace would be
  // the folder such trimming could have hidden.
  const own = host.foregroundCwd(session, pane);
  if (own === null) return say('folder', "the pane's folder cannot be read");
  if (own !== lobby) return say('folder', "the pane's folder is not the lobby as written");
  const names = host.list(dirname(lobby));
  if (names === null) return say('folder', "the lobby's parent folder cannot be read");
  const base = basename(lobby);
  if (names.some((name) => name.length > base.length && name.startsWith(base) && /\s/.test(name.charAt(base.length)))) {
    return say('folder', "the lobby's parent folder holds a name that differs from the lobby's by whitespace alone");
  }
  const listed = trust.some((entry) => canonicalLanding(folderOf(entry, root)) === lobby);
  if (!listed) return say('folder', 'this folder is not an exact trust entry');
  return { record, version: printed, folder: lobby };
}

/**
 * Writes the recovery record and reads it back: the key is only sent when the intent is
 * on disk, not merely handed to a writer. A write fault, or a state that reads back
 * without the record, refuses the send.
 */
function recordRecovery(
  dir: string,
  session: string,
  name: string,
  waiting: NonNullable<SeatState['waiting']>,
  pane: string,
  workspace: string | undefined,
): boolean {
  try {
    writeWaiting(dir, session, name, waiting, pane, workspace);
    const back = readState(dir).sessions[session]?.seats[name]?.waiting;
    return back?.state === 'trust-sent-recovery' && back.classification === 'trust';
  } catch {
    return false;
  }
}

function writeWaiting(
  dir: string,
  session: string,
  name: string,
  waiting: NonNullable<SeatState['waiting']>,
  pane: string,
  workspace: string | undefined,
): void {
  updateState(dir, (state) => {
    const current = state.sessions[session] ?? emptySession();
    state.sessions[session] = current;
    const seat = current.seats[name] ?? { stage: 'launched' as const };
    seat.waiting = waiting;
    seat.pane = pane;
    if (workspace) seat.workspace = workspace;
    current.seats[name] = seat;
  });
}

/**
 * The recovery report. Two paths reach it — a key the host did not take, and a sent key
 * whose seat did not come ready — and both leave the same `trust-sent-recovery` state,
 * so both answer with the same object shape and exit.
 */
function recovery(io: Io, json: boolean, seat: string, reason: string, human: string): number {
  if (json) io.stdout(`${JSON.stringify({ seat, dialog: 'trust', status: 'recovery', state: 'trust-sent-recovery', reason })}\n`);
  else io.stderr(`${human}\n`);
  // exit: answer.recovery
  return 1;
}

async function finish(
  io: Io,
  json: boolean,
  host: AnswerHost,
  dir: string,
  session: string,
  who: string,
  name: string,
  team: TeamFile,
  configured: Seat | undefined,
  pane: string,
  workspace: string | undefined,
): Promise<number> {
  const like = readState(dir).sessions[session]?.seats[name]?.temporary?.like;
  const seat = configured ?? team.seats.find((item) => item.name === like);
  const profile = seat ? profileFor(seat.cli) : null;
  const ready = profile ? await recover(host, session, pane, name, profile, seat as Seat, team) : 'idle';
  if (ready !== true) {
    logLine(dir, 'answer', who, `${name}: refused trust: ${ready}`, host.now());
    const reason = ready === 'idle' ? 'its idle prompt did not come' : 'its rules were not delivered';
    return recovery(io, json, name, reason, `${name}: trust sent; recovery required`);
  }
  updateState(dir, (state) => {
    const current = state.sessions[session] ?? emptySession();
    state.sessions[session] = current;
    const recorded = current.seats[name] ?? { stage: 'launched' as const };
    delete recorded.waiting;
    recorded.stage = 'ready';
    recorded.pane = pane;
    if (workspace) recorded.workspace = workspace;
    if (profile?.rulesOption === null) recorded.rules = 'message';
    current.seats[name] = recorded;
  });
  logLine(dir, 'answer', who, `${name}: trust answered`, host.now());
  if (json) io.stdout(`${JSON.stringify({ seat: name, dialog: 'trust', status: 'answered', state: 'ready' })}\n`);
  else io.stdout(`${name}: trust answered; ready\n`);
  // exit: answer.ready
  return 0;
}

async function recover(
  host: AnswerHost,
  session: string,
  pane: string,
  name: string,
  profile: Profile,
  seat: Seat,
  team: TeamFile,
): Promise<true | 'idle' | 'rule delivery'> {
  if (!(await waitIdle(host, session, pane, profile))) return 'idle';
  const named = host.agents(session)?.some((agent) => agent.name === name && agent.pane === pane) === true;
  if (!named && !host.rename(session, pane, name)) return 'rule delivery';
  if (profile.rulesOption !== null) return true;
  const text = rulesText(
    {
      coordinator: team.coordinator,
      rules: team.rules,
      signature: {
        commit: renderSignature(team.identity.signature.commits.template, seat),
        pullRequest: renderSignature(team.identity.signature.pullRequests.template, seat),
        commitPosition: team.identity.signature.commits.position,
      },
      workspace: { mode: seat.mode, protected: team.workspace.protected, branch: team.workspace.branch },
    },
    'message',
  );
  const delivered = await deliverRules(profile.cli, text, profile.idleTimeout, deliveryOf(host, session, pane));
  return delivered === true ? true : 'rule delivery';
}

async function waitIdle(host: AnswerHost, session: string, pane: string, profile: Profile): Promise<boolean> {
  const deadline = host.now().getTime() + profile.idleTimeout * 1000;
  for (;;) {
    if (readScreen(profile.cli, host.pane(session, pane)).kind === 'idle') return true;
    if (host.now().getTime() >= deadline) return false;
    const before = host.now().getTime();
    await host.sleep(200);
    if (host.now().getTime() <= before) return false;
  }
}

function deliveryOf(host: AnswerHost, session: string, pane: string): Delivery {
  return {
    screen: () => host.pane(session, pane),
    status: () => host.status(session, pane),
    type: (text) => host.type(session, pane, text),
    enter: () => host.enter(session, pane),
    foreground: () => host.foreground(session, pane),
    now: () => host.now().getTime(),
    sleep: (ms) => host.sleep(ms),
  };
}

function usage(io: Io, json: boolean, message: string): number {
  if (json) io.stdout(`${JSON.stringify({ error: { code: 'usage', message } })}\n`);
  else io.stderr(`team answer: ${message}\n${USAGE}`);
  // exit: answer.usage
  return 2;
}

function configuration(io: Io, json: boolean, message: string): number {
  if (json) io.stdout(`${JSON.stringify({ error: { code: 'configuration', message } })}\n`);
  else io.stderr(`team answer: ${message}\n`);
  // exit: answer.configuration
  return 2;
}
