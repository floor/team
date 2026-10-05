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
// that a hand run in the root finds may resolve nowhere from the lobby. The check refuses only
// what it has proved can't run: a word a shell would act on — quotes, `$`, backticks, `&&`, a
// redirection, a glob, `~user` — leaves the arguments unread, and a relative argument that names
// no existing file anywhere is only a note: the command may create it. `~/…` stands for the pane
// shell's own home, so it is looked for there: captured on herdr 0.7.1, typing
// `if [ ~ = "$HOME" ]; then echo "tilde-equals-home probe=tilde-expanded-ok"; fi` into a pane
// printed `tilde-equals-home probe=tilde-expanded-ok`, and `ls -d ~` ran.

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
  /** Whether a command is an executable on the PATH the session's server gets. For an absolute
   *  path this is also the executability test main's launcher check used: `accessSync(…, X_OK)`. */
  onPath(binary: string): boolean;
  home: string;
};

function miss(why: string): LineFinding {
  return { level: 'miss', why };
}

function note(why: string): LineFinding {
  return { level: 'note', why };
}

// Every character a shell would act on, so the word as written is not the word the shell reads:
// quotes, `$`, backticks, a backslash, redirections, pipes, separators, groups, globs, brackets.
const SHELL_TEXT = /['"`$\\<>|&;()*?[\]{}]/;

/** Whether a launch-line word is a plain word: no shell syntax, and no `~user` or `~+` expansion.
 *  `~` alone and `~/…` are the pane shell's home, which the check reads as a path. */
function plainWord(word: string): boolean {
  if (SHELL_TEXT.test(word)) return false;
  return !word.startsWith('~') || word === '~' || word.startsWith('~/');
}

const notRead = 'its launch line was not checked: it quotes or substitutes text this version does not read';

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
  // The first word is checked before anything else is read: a line whose program is missing is a
  // miss whatever follows it, and a line whose first word itself quotes or substitutes is not read.
  if (!plainWord(program)) return note(notRead);
  // A program given as a path is looked for where it would run, and must run: main's launcher
  // check was `onPath`'s `X_OK`, not existence.
  const pathProgram = (absolute: string, missing: string): LineFinding | null => {
    if (!existsSync(absolute)) return miss(missing);
    return sources.onPath(absolute) ? null : miss(`its launch line starts \`${program}\`, which is not executable`);
  };
  if (program.startsWith('~/')) {
    return pathProgram(join(sources.home, program.slice(2)), `its launch line starts \`${program}\`, not found from \`~\``);
  }
  if (program.startsWith('/')) {
    return pathProgram(program, `its launch line starts \`${program}\`, which does not exist`);
  }
  if (program.startsWith('./') || program.startsWith('../')) {
    return pathProgram(
      resolve(cwd, program),
      `its launch line starts \`${program}\`, not found from its start folder ${folder}`,
    );
  }
  return sources.onPath(program) ? null : miss(`its launch line starts \`${program}\`, which is not on the PATH`);
}

function argumentFinding(word: string, root: string, cwd: string, folder: string, sources: LineSources): LineFinding | null {
  if (word.startsWith('~/')) {
    return existsSync(join(sources.home, word.slice(2)))
      ? null
      : note(`its launch line runs \`${word}\`, not found from \`~\`; not checked: the command may create it`);
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
  return note(
    `its launch line runs \`${word}\`, not found from its start folder ${folder}; ` +
      'not checked: the command may create it',
  );
}

/** The first thing about this seat's launch line that keeps it from running where the seat
 *  starts, or null: a `miss` stops that seat's launch, a `note` is only said. `start` is where
 *  the line will run when that is not the folder the file's seat would launch in — a resumed
 *  seat, whose pane keeps the folder it was started in. */
export function launchLineFinding(
  team: TeamFile,
  seat: Seat,
  root: string,
  sources: LineSources,
  start?: { cwd: string; folder: string },
): LineFinding | null {
  const launch = seat.launch;
  const words = launch.trim().split(/\s+/).filter((word) => word !== '');
  const program = launchBinary(launch);
  if (program === null) return note('its launch line names no command');
  const folder = start?.folder ?? startFolder(team, seat);
  const cwd = start?.cwd ?? resolve(root, folder);
  const missing = programFinding(program, profileFor(seat.cli)?.binary ?? null, cwd, folder, sources);
  if (missing) return missing;
  // With any shell syntax after the first word, the split may not be what a shell would read:
  // the arguments are not checked at all, and the line is only said to be unchecked.
  if (words.some((word) => !plainWord(word))) return note(notRead);
  for (const word of words) {
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
