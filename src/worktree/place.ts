import { join } from 'node:path';
import { insideTrust, protectedBy } from '../file/paths.ts';
import type { Seat, TeamFile } from '../file/types.ts';

// A task name is one path segment. It is also the last segment of the folder and part of the branch.
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function taskProblem(task: string): string | null {
  if (!TASK_NAME.test(task)) {
    return 'a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit';
  }
  return null;
}

// Fills `{kind}` and `{task}`. Null when a placeholder has no value, or one is left that this command doesn't know.
export function fillPattern(pattern: string, values: Record<string, string | undefined>): string | null {
  let unknown = false;
  const filled = pattern.replace(/\{([^}]*)\}/g, (token, name: string) => {
    const value = values[name];
    if (value === undefined) {
      unknown = true;
      return token;
    }
    return value;
  });
  return unknown ? null : filled;
}

// The lobby: the neutral folder a seat that works in worktrees waits in until a brief names its
// worktree — the folder the worktrees go in, with ".lobby" beside them, so a trust pattern that
// covers the worktrees covers it too. Null when the file names no folder to take a parent from.
export function lobbyPath(team: Pick<TeamFile, 'project' | 'workspace'>): string | null {
  const path = team.workspace.path;
  if (!path) return null;
  const parent = path.split('/').slice(0, -1).join('/').replaceAll('{repo}', team.project) || '.';
  return join(parent, '.lobby');
}

/** Where a seat starts: the folder it waits in, or why it can't start. */
export type SeatStart = { cwd: string; lobby?: true } | { problem: string; once?: true };

// Where a seat starts. A shared seat starts in the folder the file names — usually the project
// root — and reads there. Every other seat starts outside every protected checkout: in the lobby
// when the file gives it no folder of its own, or in the folder it names when that one is safe.
// `once` marks a problem that is the same for every seat, so a caller says it once.
export function seatStart(team: Pick<TeamFile, 'project' | 'workspace' | 'trust'>, seat: Seat): SeatStart {
  if (seat.mode === 'shared') return { cwd: seat.cwd };
  if (seat.cwd !== '.') {
    const hit = protectedBy(seat.cwd, team.workspace.protected);
    if (hit) {
      return {
        problem:
          `seat ${seat.name} would start in ${seat.cwd}, inside the protected checkout ${hit}; ` +
          "a seat that isn't `mode: shared` never starts in one",
      };
    }
    return { cwd: seat.cwd };
  }
  const lobby = lobbyPath(team);
  if (lobby === null) {
    return {
      problem: 'a seat that works in worktrees has no lobby to wait in: workspace.path must name the folder {task} goes under',
      once: true,
    };
  }
  const hit = protectedBy(lobby, team.workspace.protected);
  if (hit) {
    return {
      problem:
        `seat ${seat.name} would start in the lobby ${lobby}, inside the protected checkout ${hit}; ` +
        "a seat that isn't `mode: shared` never starts in one",
    };
  }
  if (!insideTrust(lobby, team.trust)) {
    return {
      problem:
        `the lobby ${lobby} matches no trust pattern (${team.trust.join(', ') || 'none'}): ` +
        'add one that covers it and run `team approve`',
      once: true,
    };
  }
  return { cwd: lobby, lobby: true };
}

// The first name a public project's forbidden_public pattern matches, as "name matches pattern".
export function publicNameHit(team: Pick<TeamFile, 'visibility' | 'identity'>, names: string[]): string | null {
  if (team.visibility !== 'public') return null;
  for (const source of team.identity.forbiddenPublic) {
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (error) {
      return `forbidden_public pattern ${JSON.stringify(source)} is not a regular expression: ${(error as Error).message}`;
    }
    for (const name of names) {
      if (regex.test(name)) return `${JSON.stringify(name)} matches forbidden_public ${JSON.stringify(source)}`;
    }
  }
  return null;
}
