import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { agentList, paneRead, sessionRunning, workspaceList } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { emptySession, readState, updateState } from '../state.ts';
import { compare } from '../status/compare.ts';
import type { Comparison, Difference, Live } from '../status/compare.ts';

// What `status` reads from outside the file and the state, so tests can stand in for it.
export type StatusSources = {
  live(session: string, team: TeamFile): Live | null;
  branch(path: string): string | null;
  now(): Date;
};

export const realSources: StatusSources = {
  live(session, team) {
    const running = sessionRunning(session);
    if (running === null) return null;
    if (!running) return { running: false, agents: [], workspaces: [], screens: {} };
    const agents = agentList(session);
    const workspaces = workspaceList(session);
    if (!agents || !workspaces) return null;
    const screens: Record<string, string> = {};
    for (const agent of agents) {
      if (!team.seats.some((seat) => seat.name === agent.name)) continue;
      const screen = paneRead(agent.pane, 12, session);
      if (screen !== null) screens[agent.pane] = screen;
    }
    return { running: true, agents, workspaces, screens };
  },
  branch(path) {
    try {
      return execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
  now: () => new Date(),
};

export const status: Command = (argv, io) => runStatus(argv, io, realSources);
export default status;

export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], []);
  if (args.error || args.rest.length) {
    io.stderr(`team status: ${args.error ?? `unexpected "${args.rest[0]}"`}\nUsage: team status [--session <name>] [--file <path>]\n`);
    return 2;
  }

  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  let team: TeamFile;
  let root: string;
  let dir: string;
  if (loaded.ok) {
    ({ team, root } = loaded);
    dir = dirname(loaded.path);
    for (const warning of loaded.warnings) io.stderr(`team status: warning, line ${warning.line}: ${warning.message}\n`);
    rememberValid(dir, loaded.path, sources.now());
  } else {
    // A broken file is when status is needed most: fall back to the last copy that validated.
    const fallback = loaded.path && existsSync(loaded.path) ? lastValid(dirname(loaded.path)) : null;
    if (!fallback || !loaded.path) {
      printProblems(io, loaded.errors);
      return 2;
    }
    const first = loaded.errors[0];
    io.stdout(`team.yaml is invalid (${first && first.line ? `line ${first.line}: ` : ''}${first?.message ?? 'unreadable'}); using the copy of ${fallback.readAt}\n`);
    team = fallback.team;
    dir = dirname(loaded.path);
    root = dir.endsWith('.agents') ? dirname(dir) : dir;
  }

  const session = args.values.session ?? team.session;
  const live = sources.live(session, team);
  if (!live) {
    io.stderr('team status: herdr doesn\'t answer; is it installed and running?\n');
    return 2;
  }
  const state = readState(dir).sessions[session] ?? emptySession();
  const comparison = compare(team, session, state, live, sources.now());
  if (!live.running) comparison.notes.unshift(`the herdr session "${session}" is not running`);
  comparison.differences.push(...protectedCheckouts(team, root, sources));

  io.stdout(render(team, session, comparison));
  return comparison.differences.length ? 1 : 0;
}

function protectedCheckouts(team: TeamFile, root: string, sources: StatusSources): Difference[] {
  const base = team.workspace.base;
  if (!base) return [];
  const out: Difference[] = [];
  for (const path of team.workspace.protected) {
    const full = resolve(root, path);
    const branch = sources.branch(full);
    if (branch === null || branch === base) continue;
    const shown = relative(root, full) || '.';
    out.push({
      what: `the protected checkout "${shown}" is on ${branch === 'HEAD' ? 'a detached commit' : `"${branch}"`}, not on "${base}"`,
      repair: `the owner switches it back: git -C ${shown} switch ${base}`,
    });
  }
  return out;
}

function render(team: TeamFile, session: string, comparison: Comparison): string {
  const lines = [`team ${team.project}, session "${session}"`];
  const widths = [0, 0, 0];
  for (const row of comparison.rows) {
    widths[0] = Math.max(widths[0] as number, row.name.length);
    widths[1] = Math.max(widths[1] as number, row.state.length);
    widths[2] = Math.max(widths[2] as number, row.model.length);
  }
  for (const row of comparison.rows) {
    lines.push(`  ${row.name.padEnd(widths[0] as number)}  ${row.state.padEnd(widths[1] as number)}  ${row.model.padEnd(widths[2] as number)}  ${row.pane}`.trimEnd());
  }
  for (const note of comparison.notes) lines.push(`note: ${note}`);
  for (const difference of comparison.differences) {
    lines.push(`difference: ${difference.what}`, `  repair: ${difference.repair}`);
  }
  lines.push(`${comparison.differences.length} difference(s)`);
  return `${lines.join('\n')}\n`;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team status: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}

// Saves the file's text in the state when it changed, for the day the file is broken.
function rememberValid(dir: string, path: string, now: Date): void {
  const file = readFileSync(path, 'utf8');
  try {
    if (readState(dir).last_valid?.file === file) return;
    updateState(dir, (state) => {
      state.last_valid = { read_at: now.toISOString(), file };
    });
  } catch {
    // A state that can't be written must not stop a read-only command.
  }
}

function lastValid(dir: string): { team: TeamFile; readAt: string } | null {
  try {
    const saved = readState(dir).last_valid;
    if (!saved) return null;
    const result = validateTeamFile(saved.file);
    return result.ok ? { team: result.team, readAt: saved.read_at } : null;
  } catch {
    return null;
  }
}
