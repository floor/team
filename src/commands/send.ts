import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, callerVerdict, describeCaller, judgeCallerIn, noPaneRefusal, standingOf, type Caller, type SeatStanding } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { agentList, paneProcesses, type PaneProcesses } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../send/uds.ts';

export const USAGE = `Usage: team send <seat> <message>
       team send <seat> --file <path>

Writes one message to one seat over the cross-session message socket — the channel a
Claude Code session exposes, never typing into its pane. Only the owner, or the
orchestrator from its own seat, may call it; a worker seat may not.

The outcome is one of three, and none of them is silent:
  delivered    the seat's socket took the frame (exit 0)
  unreachable  that socket could not take it (exit 1): the session is not running, no
               live agent carries the seat's name, no socket file was found for its
               pane's processes, or the connection would not take the frame
  refused      nothing was sent (exit 1): not a declared seat, a channel this build
               does not carry yet, a message over the socket's measured limit, or a
               caller that may not send

The send is one frame with no acknowledgement: this channel reports nothing back, so
"delivered" means the socket accepted the frame — the receiving session's own inbound
policy decides when it surfaces. --file reads the body from a file instead of the one
<message> argument.

Not in this build, and marked TODO where they will land: delivery to a native-CLI seat
(the daemon), --wait/--timeout, --json, --list and broadcast.
`;

export type SendHost = {
  /** The live agents of a session; null when herdr can't be reached. */
  agents(session: string): { name: string; pane: string }[] | null;
  /** A pane's process pids, or null when the pane can't be read. */
  processInfo(session: string, pane: string): PaneProcesses | null;
  /** The folder the session sockets live in; the real one is the runtime temp folder's. */
  socketsDir: string;
  deliver(socketPath: string, frame: string): Promise<SendOutcome>;
  now(): Date;
  home: string;
};

export const realHost: SendHost = {
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane })) ?? null,
  processInfo: (session, pane) => paneProcesses(pane, session),
  // The probe's path shape: `<tmp>/cc-socks/<pid>.sock`, the runtime temp folder's own
  // (observed on this Mac as /tmp/cc-socks; a version-specific observation, not a public
  // API contract).
  socketsDir: join(tmpdir(), 'cc-socks'),
  deliver: (socketPath, frame) => sendFrame(socketPath, frame),
  now: () => new Date(),
  home: homedir(),
};

const send: Command = (argv, io) => runSend(argv, io, realHost);
export default send;

export async function runSend(argv: string[], io: Io, host: SendHost): Promise<number> {
  const args = readArgs(argv, ['file'], []);
  const seatName = args.rest[0];
  const words = args.rest.slice(1);
  const file = args.values.file;
  if (args.error || !seatName) {
    return usage(io, args.error ?? 'a seat and a message are required');
  }
  if (file !== undefined && words.length > 0) {
    return usage(io, 'a message and --file cannot both be given');
  }
  if (file === undefined && words.length === 0) {
    return usage(io, 'a message or --file is required');
  }

  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, message || 'the team file cannot be read');
  }
  const { team } = loaded;
  const dir = dirname(loaded.path);

  // The caller check mirrors `answer`'s: the owner, or the orchestrator from its own seat on
  // the pane the state records — never an arbitrary seat. It runs before the message is read
  // and before any seat is probed.
  const judged = judgeCallerIn(io, dir, team);
  const { caller } = judged;
  const who = logWho(caller, team);
  const callerProblem = callerProblemOf(caller, team, standingOf(dir, judged.session, caller));
  if (callerProblem) return refuse(io, dir, who, callerProblem, host);

  const configured = team.seats.find((seat) => seat.name === seatName);
  if (!configured) {
    return refuse(io, dir, who, `${seatName}: it is not a declared seat; the file's seats are ${seatList(team)}`, host);
  }
  // Delivery picks the channel by seat kind. Only the socket channel is built in this
  // increment. TODO (a later increment, delivered by its own build): a native-vendor-CLI
  // seat (codex, cursor, grok, antigravity) delivers through the delivery daemon —
  // file-drop and a short trigger, never this process typing into the pane.
  if (configured.cli !== 'claude-code') {
    return refuse(io, dir, who, `${seatName} runs ${configured.cli}: this build carries the cross-session socket channel only, and the delivery daemon for a native CLI is not built yet; nothing was sent`, host);
  }

  let body: string;
  if (file !== undefined) {
    try {
      body = readFileSync(resolve(io.cwd, file), 'utf8');
    } catch {
      return configuration(io, `the message file cannot be read: ${file}`);
    }
  } else {
    body = words.join(' ');
  }
  if (body.trim() === '') return usage(io, 'the message is empty');

  // One JSON line, exactly the frame the probe measured: `type:"user"`, the content, and a
  // msg_id for a reader's own correlation. No `from`: this process has no session socket, so
  // any sender address it claimed would be a claim, not a fact — the listener shows the
  // connection's verified pid instead. JSON.stringify escapes newlines and control
  // characters, so multi-line text stays one frame; the frame is never truncated.
  const frame = `${JSON.stringify({ type: 'user', message: { role: 'user', content: body }, msg_id: randomUUID() })}\n`;
  if (frame.length > FRAME_LIMIT) {
    return refuse(io, dir, who, `${seatName}: the message is too large for this channel: the frame is ${String(frame.length)} characters and the socket's measured limit is ${String(FRAME_LIMIT)}; nothing was sent`, host);
  }

  const agents = host.agents(team.session);
  if (agents === null) {
    return unreachable(io, dir, who, seatName, `the session "${team.session}" could not be read`, host);
  }
  const named = agents.filter((agent) => agent.name === seatName);
  if (named.length === 0) {
    return unreachable(io, dir, who, seatName, 'no live agent carries that name in the session', host);
  }
  if (named.length > 1) {
    return refuse(io, dir, who, `${seatName}: herdr lists more than one agent of this name; nothing was sent`, host);
  }
  const pane = (named[0] as { pane: string }).pane;
  const processes = host.processInfo(team.session, pane);
  if (processes === null) {
    return unreachable(io, dir, who, seatName, "the pane's processes could not be read", host);
  }
  const socketPath = socketOf(host, processes);
  if (socketPath === null) {
    return unreachable(io, dir, who, seatName, `no cross-session socket was found for its pane's processes (looked in ${host.socketsDir})`, host);
  }

  // One send per seat at a time, the same lock `answer` and the launch that resumes a seat
  // take: two commands never reach one seat at once.
  const lock = acquireSeatLock(dir, team.session, seatName);
  if (!('release' in lock)) {
    return refuse(io, dir, who, `${seatName}: another command holds it (pid ${String(lock.held)}); nothing was sent`, host);
  }
  try {
    const delivered = await host.deliver(socketPath, frame);
    if (!delivered.ok) {
      return unreachable(io, dir, who, seatName, delivered.reason, host);
    }
    // The log keeps the seat and the frame's size; never the message's text.
    logLine(dir, 'send', who, `${seatName}: delivered (${String(frame.length)} characters)`, host.now());
    io.stdout(`${seatName}: delivered\n`);
    return 0; // exit: send.delivered
  } finally {
    lock.release();
  }
}

/**
 * The first of the pane's processes with a socket in the sockets folder: the foreground
 * processes first (the running CLI is one of them), then the shell. The probe's socket is
 * derived from one process — the session — so more than one match is not resolved here:
 * the first is used, in that order.
 */
function socketOf(host: SendHost, processes: PaneProcesses): string | null {
  const pids = [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
  for (const pid of pids) {
    const path = join(host.socketsDir, `${String(pid)}.sock`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The caller class the caller check returned, as the log's bracket: `answer`'s own. */
function logWho(caller: Caller, team: TeamFile): string {
  if (caller.kind === 'owner' || caller.kind === 'owner-no-tty') return 'owner';
  if (caller.kind === 'unplaced') return 'unplaced';
  if (caller.kind === 'pane') return caller.session === undefined ? caller.pane : `${caller.session}/${caller.pane}`;
  return caller.name === team.orchestrator ? 'orchestrator' : 'seat';
}

/**
 * Why the caller may not send, or null. The owner; the orchestrator's seat, in the session
 * judged and on its recorded pane — the same verdict `answer` asks before it acts, with
 * `answer`'s refusal texts for the two placements it can name, and the authority rule named
 * in the rest.
 */
function callerProblemOf(caller: Caller, team: TeamFile, at?: SeatStanding): string | null {
  if (caller.kind === 'owner') return null;
  const verdict = callerVerdict(caller, team.orchestrator, at);
  if (verdict.kind === 'ok') return null;
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (caller.kind === 'unplaced') return caller.reason;
  if (caller.kind === 'pane') return `${describeCaller(caller)}: only the owner, or the orchestrator from its own seat, can send`;
  return `a seat may not send (${describeCaller(caller)}): only the owner, or the orchestrator from its own seat, can send`;
}

function seatList(team: TeamFile): string {
  const names = team.seats.map((seat) => seat.name);
  return names.length === 0 ? '(none)' : names.join(', ');
}

/** A refusal: the message was not written, and the reason says why. Exit 1, always. */
function refuse(io: Io, dir: string, who: string, reason: string, host: SendHost): number {
  logLine(dir, 'send', who, `refused: ${reason}`, host.now());
  io.stderr(`team send: refused: ${reason}\n`);
  return 1; // exit: send.refused
}

/** The seat's channel was not open, and nothing was sent. Exit 1, always. */
function unreachable(io: Io, dir: string, who: string, seat: string, reason: string, host: SendHost): number {
  logLine(dir, 'send', who, `${seat}: unreachable: ${reason}`, host.now());
  io.stderr(`team send: ${seat}: unreachable: ${reason}\n`);
  return 1; // exit: send.unreachable
}

function usage(io: Io, message: string): number {
  io.stderr(`team send: ${message}\n${USAGE}`);
  return 2; // exit: send.usage
}

function configuration(io: Io, message: string): number {
  io.stderr(`team send: ${message}\n`);
  return 2; // exit: send.configuration
}
