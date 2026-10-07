import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { budgetLine } from '../budgets/table.ts';
import { isOwner, walkCaller } from '../caller.ts';
import { loadTeamFile, TEAM_FILE } from '../file/load.ts';
import type { LoadResult, Problem } from '../file/types.ts';
import { NO_FIGURES, projectUsage, type ProjectUsage } from '../information/usage.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = 'Usage: team usage [--json]\n';

/** The sentence a run outside any project prints: it names no git and no flag this command
 *  does not have, and it is a note with exit 0, not a refusal. */
export const NO_PROJECT = 'no team file is found from this folder; there is no project block to show';

/** What the command reads from outside itself: the home whose store it consults, and the clock. */
export type UsageSources = {
  /** The home whose approval store is read. Required, so no test can reach the owner's own. */
  home: string;
  now(): Date;
};

export const realSources: UsageSources = { home: homedir(), now: () => new Date() };

export const usage: Command = (argv, io) => runUsage(argv, io, realSources);
export default usage;

/**
 * `team usage [--json]`: this project's block, resolved from the current folder the way
 * `currentTeam` resolves, but read-only — it writes nothing anywhere, not even the `last_valid`
 * copy `currentTeam` keeps, and it never answers from that copy when the file breaks. Any caller
 * may run it, from any folder. The caller is placed once, the way `status` places it
 * (`status.ts:133`): the owner at a terminal is the owner, and everyone else — a seat, an agent
 * outside herdr, a run without a terminal — reads the restricted view, whose differences here are
 * the fixed line for a refused approval (`NOT_VERIFIED`) in place of the store's own words, and,
 * for a file that does not load or cannot be read, a fixed sentence naming this project's own path
 * relative to the root in place of the loader's own message (`noticeOf`, `errorNote`) — the
 * loader's bodies can name paths outside this project. The state's note keeps the state's own
 * reason with its path made relative (`shownNote`). No absolute path reaches the restricted view.
 * Placing the caller reads the process table (`caller.ts`), and nothing else. Exit
 * 0 whatever the figures; the one refusal is the invocation.
 */
export async function runUsage(argv: string[], io: Io, sources: UsageSources): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  if (args.error || args.rest.length) {
    io.stderr(`team usage: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: usage.invocation
    return 2;
  }
  const restricted = !isOwner(walkCaller(io));
  const now = sources.now();
  const json = args.flags.has('json');
  let loaded: LoadResult;
  try {
    loaded = loadTeamFile(io.cwd, { home: sources.home });
  } catch (error) {
    // A file that exists and cannot be read: the loader's own reason, as a note line, exit 0.
    return outside(io, json, now, [errorNote(error, restricted)]);
  }
  if (!loaded.ok) {
    // No file at all — no repository, or a repository with no team file: outside a project. A
    // file that exists and does not load is this team's own problem: the loader's own message,
    // with the path, as note lines — or, for a caller who is not the owner, one fixed sentence per
    // line, with no body (`noticeOf`). Exit 0 either way.
    const notes = !loaded.path || !existsSync(loaded.path)
      ? [NO_PROJECT]
      : notesOf(loaded.path as string, loaded.errors, restricted);
    return outside(io, json, now, notes);
  }
  const report = projectUsage(loaded.root, { home: sources.home, now: now.getTime(), restricted });
  if (json) {
    // The reader's one line for a block whose file counts nothing heads the notes, so a script
    // reads it where the text's reader sees it: under the header, under the rows.
    const notes = report.whyNotCounted === null ? report.notes : [report.whyNotCounted, ...report.notes];
    io.stdout(`${JSON.stringify({
      format: 1,
      at: now.toISOString(),
      view: 'restricted',
      mine: report.project,
      rows: report.rows.map((entry) => entry.row),
      watch: report.watch,
      notes,
    }, null, 2)}\n`);
  } else {
    io.stdout(render(report));
  }
  // exit: usage.block
  return 0;
}

function render(report: ProjectUsage): string {
  const lines = report.project === null ? [NO_FIGURES] : [`team ${report.project}`];
  for (const entry of report.rows) lines.push(`  ${budgetLine(entry.row)}`);
  if (report.whyNotCounted !== null) lines.push(report.whyNotCounted);
  if (report.watch === 'not-recording' && report.project !== null) {
    lines.push(`no watch is recording for ${report.project}`);
  } else if (report.watch === 'not-known') {
    lines.push('not known whether a watch is recording');
  }
  for (const note of report.notes) lines.push(`note: ${note}`);
  return `${lines.join('\n')}\n`;
}

/** One note for a file that exists and does not load. The owner reads the loader's own message:
 *  the path, the line when it has one, and the problem — never the bare `no team file here` text,
 *  which is a different case's sentence. A caller who is not the owner reads a fixed sentence
 *  instead — this project's own path relative to the root, the line, and where the reason is —
 *  because the loader's bodies are the loader's own and can name paths outside this project
 *  (`trust: must list the lobby <home>/…` when a migrated file omits it), and `team status`
 *  prints every one of them with the bodies, as a run showed (stderr, exit 2). */
function noticeOf(path: string, problem: Problem, restricted: boolean): string {
  if (restricted) return `${TEAM_FILE} does not load${problem.line ? ` (line ${problem.line})` : ''}: run team status for the reason`;
  return `${path}${problem.line ? ` line ${problem.line}` : ''}: ${problem.message}`;
}

/** The notes for a file that exists and does not load: one per problem for the owner, and one per
 *  distinct line for a caller who is not the owner — the fixed sentences carry nothing else, so
 *  three problems on one line are one note. */
function notesOf(path: string, errors: Problem[], restricted: boolean): string[] {
  const notes = errors.map((problem) => noticeOf(path, problem, restricted));
  return restricted ? [...new Set(notes)] : notes;
}

/** The note for a file that exists and cannot be read: the error's own message for the owner, one
 *  fixed sentence for a caller who is not the owner, whose body is the error's own (an errno
 *  error can name the path it failed on) and so does not pass through. The sentence names the
 *  owner as the reader of the reason: `team status` is no pointer here — a run showed it throws on
 *  this same fixture instead of printing anything. */
function errorNote(error: unknown, restricted: boolean): string {
  if (restricted) return `${TEAM_FILE} cannot be read: the owner reads the reason`;
  return error instanceof Error ? error.message : String(error);
}

/** The face of a run with no project block: the notes as `note:` lines, or the same reading as
 *  one JSON document — `mine` null, no rows, the watch not known. Exit 0. */
function outside(io: Io, json: boolean, now: Date, notes: string[]): number {
  if (json) {
    io.stdout(`${JSON.stringify({
      format: 1,
      at: now.toISOString(),
      view: 'restricted',
      mine: null,
      rows: [],
      watch: 'not-known',
      notes,
    }, null, 2)}\n`);
  } else {
    for (const note of notes) io.stdout(`note: ${note}\n`);
  }
  // exit: usage.outside
  return 0;
}
