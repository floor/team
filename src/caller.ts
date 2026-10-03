import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { TeamFile } from './file/types.ts';
import { agentList, paneRootPid } from './herdr.ts';
import type { HerdrAgent } from './herdr.ts';
import { CLI_PROCESSES } from './clis.ts';

// Who runs this command, placed by its parent processes, never by its environment. This guards
// against a mistaken agent, not a hostile one: every seat runs as the owner's user.

export type Caller =
  | { kind: 'owner' }
  | { kind: 'seat'; name: string; pane: string }
  | { kind: 'unplaced'; reason: string };

export type Process = { pid: number; name: string };

export type CallerSources = {
  // The command's parent processes, nearest first.
  ancestors(): Process[];
  agents(): HerdrAgent[] | null;
  paneRootPid(pane: string): number | null;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
};

export function placeCaller(sources: CallerSources): Caller {
  const ancestors = sources.ancestors();
  if (!ancestors.length) return { kind: 'unplaced', reason: 'its parent processes can\'t be read' };
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

// The parent processes of `pid`, nearest first, by name only: arguments can hold credentials.
export function readAncestors(pid: number = process.ppid): Process[] {
  const out: Process[] = [];
  let at = pid;
  for (let depth = 0; depth < 64 && at > 1; depth++) {
    let line: string;
    try {
      line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(at)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      break;
    }
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) break;
    out.push({ pid: at, name: basename(match[2] as string).replace(/^-/, '') });
    at = Number(match[1]);
  }
  return out;
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
