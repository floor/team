import { execFileSync } from 'node:child_process';
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
  if (!sources.stdinIsTTY) return { kind: 'unplaced', reason: 'it doesn\'t run on a terminal' };
  return { kind: 'owner' };
}

export function isOwner(caller: Caller): boolean {
  return caller.kind === 'owner';
}

// The owner, or the coordinator's or the operator's seat: who may change a running team.
export function mayChangeTeam(caller: Caller, team: Pick<TeamFile, 'coordinator' | 'operator'>): boolean {
  if (caller.kind === 'owner') return true;
  return caller.kind === 'seat' && (caller.name === team.coordinator || caller.name === team.operator);
}

export function describeCaller(caller: Caller): string {
  if (caller.kind === 'owner') return 'owner';
  if (caller.kind === 'seat') return caller.name;
  return `unplaced (${caller.reason})`;
}

// One process's parent and name, or null. By name only: arguments can hold credentials.
export type ReadProcess = (pid: number) => { ppid: number; name: string } | null;

const readWithPs: ReadProcess = (pid) => {
  try {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { ppid: Number(match[1]), name: basename(match[2] as string).replace(/^-/, '') } : null;
  } catch {
    return null;
  }
};

// The parent processes of `pid`, nearest first, up to the system's first process. Null when a
// process on the way can't be read, or the chain is longer than any real one: a partial list
// could hide the herdr server above it.
export function readAncestors(pid: number = process.ppid, read: ReadProcess = readWithPs): Process[] | null {
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
