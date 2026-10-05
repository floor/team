import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { TeamFile } from './file/types.ts';
import { agentList, paneRootPid } from './herdr.ts';
import type { HerdrAgent } from './herdr.ts';
import type { Io } from './io.ts';
import { CLI_PROCESSES } from './clis.ts';

// Who runs this command, placed by its parent processes, never by its environment. This guards
// against a mistaken agent, not a hostile one: every seat runs as the owner's user.

export type Caller =
  | { kind: 'owner' }
  // An owner's process with no terminal to prompt on: a script, a pty-less runner. It may run
  // `up` (which then never prompts), and it is refused everywhere a terminal was required.
  | { kind: 'owner-no-tty' }
  | { kind: 'seat'; name: string; pane: string }
  | { kind: 'unplaced'; reason: string };

export type Process = { pid: number; name: string };

export type CallerSources = {
  // The command's parent processes, nearest first, up to the first process of the system; null
  // when the walk stopped before it got there.
  ancestors(): Process[] | null;
  agents(): HerdrAgent[] | null;
  paneRootPid(pane: string): number | null;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
};

export function placeCaller(sources: CallerSources): Caller {
  const ancestors = sources.ancestors();
  // A walk that stopped early may have stopped below a herdr server: it places nobody.
  if (!ancestors?.length) return { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' };
  const pids = new Set(ancestors.map((process) => process.pid));

  if (ancestors.some((process) => process.name === 'herdr')) {
    const agents = sources.agents();
    if (!agents) return { kind: 'unplaced', reason: 'it runs under herdr, and herdr doesn\'t answer' };
    // The variable only says which pane to read first; the pids decide.
    const hint = sources.env.HERDR_PANE_ID;
    const ordered = [...agents].sort((a, b) => Number(b.pane === hint) - Number(a.pane === hint));
    for (const agent of ordered) {
      const root = sources.paneRootPid(agent.pane);
      if (root === null || !pids.has(root)) continue;
      if (agent.name) return { kind: 'seat', name: agent.name, pane: agent.pane };
      return { kind: 'unplaced', reason: `it runs in pane ${agent.pane}, whose agent has no herdr name` };
    }
    return { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' };
  }

  const cli = ancestors.find((process) => CLI_PROCESSES.includes(process.name));
  if (cli) return { kind: 'unplaced', reason: `it is run by an agent (${cli.name}) outside herdr` };
  if (sources.env.AGENT_UNATTENDED) return { kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' };
  if (!sources.stdinIsTTY) return { kind: 'owner-no-tty' };
  return { kind: 'owner' };
}

export function isOwner(caller: Caller): boolean {
  return caller.kind === 'owner';
}

/**
 * Who may launch seats: the owner at a terminal, and the otherwise-verified owner without one.
 * Only `up` reads this, and only to tell the two apart — the no-terminal one never prompts. Every
 * other command keeps its refusals exactly: `isOwner` is still the terminal case alone.
 */
export function mayLaunchSeats(caller: Caller): boolean {
  return caller.kind === 'owner' || caller.kind === 'owner-no-tty';
}

// The owner, or the coordinator's or the operator's seat: who may change a running team.
export function mayChangeTeam(caller: Caller, team: Pick<TeamFile, 'coordinator' | 'operator'>): boolean {
  if (caller.kind === 'owner') return true;
  return caller.kind === 'seat' && (caller.name === team.coordinator || caller.name === team.operator);
}

export function describeCaller(caller: Caller): string {
  if (caller.kind === 'owner') return 'owner';
  if (caller.kind === 'owner-no-tty') return 'owner (no terminal)';
  if (caller.kind === 'seat') return caller.name;
  return `unplaced (${caller.reason})`;
}

/** The bracket a log line carries. The owner is `owner` with or without a terminal: the log's
 *  caller column names classes, and `(no terminal for owner)` on the record already says the rest. */
export function callerLabel(caller: Caller): string {
  if (caller.kind === 'owner' || caller.kind === 'owner-no-tty') return 'owner';
  return describeCaller(caller);
}

// One process's parent and name, or null. By name only: arguments can hold credentials.
export type ReadProcess = (pid: number) => { ppid: number; name: string } | null;

// A process's name, however the platform spells it: ps prints a path, /proc a bare name, and a
// login shell leads with a dash.
function processName(raw: string): string {
  return basename(raw).replace(/^-/, '');
}

export const readWithPs: ReadProcess = (pid) => {
  try {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { ppid: Number(match[1]), name: processName(match[2] as string) } : null;
  } catch {
    return null;
  }
};

// "10 (herdr) S 1 10 …", one line of /proc/<pid>/stat: the name in parentheses — it can hold
// spaces and parentheses, so the last of them closes it — then the state, then the parent.
export function parseStat(text: string): { ppid: number; name: string } | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const after = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(after[1]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  const name = processName(text.slice(open + 1, close));
  return name ? { ppid, name } : null;
}

// One process, from Linux's own table. `proc` is the /proc root, a parameter so a test can walk a
// captured one.
export function readWithProc(pid: number, proc = '/proc'): { ppid: number; name: string } | null {
  try {
    return parseStat(readFileSync(`${proc}/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

// The table this platform keeps: Linux answers from /proc, every other system through ps.
export function processReader(platform: string = process.platform): ReadProcess {
  return platform === 'linux' ? readWithProc : readWithPs;
}

// The parent processes of `pid`, nearest first, up to the system's first process. Null when a
// process on the way can't be read, or the chain is longer than any real one: a partial list
// could hide the herdr server above it.
export function readAncestors(pid: number = process.ppid, read: ReadProcess = processReader()): Process[] | null {
  const out: Process[] = [];
  let at = pid;
  for (let depth = 0; depth < 64; depth++) {
    if (at <= 1) return out;
    const found = read(at);
    if (!found) return null;
    out.push({ pid: at, name: found.name });
    at = found.ppid;
  }
  return null;
}

// The caller of a command: the one a test handed in, or the one the processes show.
export function callerOf(io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller'>, session?: string): Caller {
  return io.caller ?? currentCaller(io, session);
}

export function currentCaller(io: { env: Record<string, string | undefined>; stdinIsTTY: boolean }, session?: string): Caller {
  return placeCaller({
    ancestors: () => readAncestors(),
    agents: () => agentList(session),
    paneRootPid: (pane) => paneRootPid(pane, session),
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  });
}
