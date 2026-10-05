import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Seat, TeamFile } from '../file/types.ts';
import { profileFor } from '../profiles/index.ts';
import { lobbyPath } from '../worktree/place.ts';

// A launch line is not shell-parsed: `team` splits it the way it always has, on whitespace, and
// examines the program — its first word that is not a variable assignment — and the arguments
// written `./…`, `../…` or `~/…`. A relative path in a launch line means one thing: a command line
// run in the folder the seat starts in, which `team` does not rewrite. A seat that works in
// worktrees starts in the lobby, beside the worktrees, not in the project root, so `../tools/x.sh`
// that a hand run in the root finds may resolve nowhere from the lobby. A line that quotes or
// substitutes text is left alone and said to be unchecked: the split may not be what a shell would
// read, and a wrong reading must never cost a seat its launch.

/** The command a launch line starts, or null when it names none. */
export function launchBinary(launch: string): string | null {
  return (
    launch
      .trim()
      .split(/\s+/)
      .find((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? null
  );
}

/** The folder a seat's launch line runs in, as the file writes it: the lobby for a seat that
 *  works in worktrees and names no folder of its own, the seat's own folder otherwise. */
export function startFolder(team: TeamFile, seat: Seat): string {
  if (seat.mode !== 'shared' && seat.cwd === '.') return lobbyPath(team) ?? '.';
  return seat.cwd;
}

export type LineFinding = { level: 'miss' | 'note'; why: string };

/** What `team doctor` and the launch are told about this machine. */
export type LineSources = {
  /** Whether a command is an executable on the PATH the session's server gets. */
  onPath(binary: string): boolean;
  home: string;
};

function miss(why: string): LineFinding {
  return { level: 'miss', why };
}

function note(why: string): LineFinding {
  return { level: 'note', why };
}

function programFinding(
  program: string,
  own: string | null,
  cwd: string,
  folder: string,
  sources: LineSources,
): LineFinding | null {
  // The profile's own binary is looked for with its install, whose finding refuses the whole
  // command; this check is the seat's own line, and only that seat's launch is stopped by it.
  if (program === own) return null;
  if (program.startsWith('~/')) {
    return existsSync(join(sources.home, program.slice(2))) ? null : miss(`its launch line starts \`${program}\`, not found from \`~\``);
  }
  if (program.startsWith('/')) {
    return existsSync(program) ? null : miss(`its launch line starts \`${program}\`, which does not exist`);
  }
  if (program.startsWith('./') || program.startsWith('../')) {
    return existsSync(resolve(cwd, program)) ? null : miss(`its launch line starts \`${program}\`, not found from its start folder ${folder}`);
  }
  return sources.onPath(program) ? null : miss(`its launch line starts \`${program}\`, which is not on the PATH`);
}

function argumentFinding(word: string, root: string, cwd: string, folder: string, sources: LineSources): LineFinding | null {
  if (word.startsWith('~/')) {
    return existsSync(join(sources.home, word.slice(2))) ? null : miss(`its launch line runs \`${word}\`, not found from \`~\``);
  }
  if (!word.startsWith('./') && !word.startsWith('../')) return null;
  if (existsSync(resolve(cwd, word))) return null;
  const fromRoot = resolve(root, word);
  if (existsSync(fromRoot)) {
    return miss(
      `its launch line runs \`${word}\`, not found from its start folder ${folder}; ` +
        `the same file is at \`${fromRoot}\` from the project root — write that path`,
    );
  }
  return miss(`its launch line runs \`${word}\`, not found from its start folder ${folder}`);
}

/** The first thing about this seat's launch line that keeps it from running where the seat
 *  starts, or null: a `miss` stops that seat's launch, a `note` is only said. */
export function launchLineFinding(
  team: TeamFile,
  seat: Seat,
  root: string,
  sources: LineSources,
): LineFinding | null {
  const launch = seat.launch;
  if (/['"`$\\]/.test(launch)) {
    return note('its launch line was not checked: it quotes or substitutes text this version does not read');
  }
  const program = launchBinary(launch);
  if (program === null) return note('its launch line names no command');
  const folder = startFolder(team, seat);
  const cwd = resolve(root, folder);
  const missing = programFinding(program, profileFor(seat.cli)?.binary ?? null, cwd, folder, sources);
  if (missing) return missing;
  for (const word of launch.trim().split(/\s+/)) {
    const hit = argumentFinding(word, root, cwd, folder, sources);
    if (hit) return hit;
  }
  return null;
}

/** One finding per seat the file would start, named for the report's list. */
export function launchLineFindings(team: TeamFile, root: string, sources: LineSources): { level: 'miss' | 'note'; text: string }[] {
  const findings: { level: 'miss' | 'note'; text: string }[] = [];
  for (const seat of team.seats) {
    if (seat.stopped) continue;
    const one = launchLineFinding(team, seat, root, sources);
    if (one) findings.push({ level: one.level, text: `${seat.name}: ${one.why}` });
  }
  return findings;
}
