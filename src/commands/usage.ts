import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { budgetLine } from '../budgets/table.ts';
import { loadTeamFile } from '../file/load.ts';
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
 * may run it, from any folder. Exit 0 whatever the figures; the one refusal is the invocation.
 */
export async function runUsage(argv: string[], io: Io, sources: UsageSources): Promise<number> {
  const args = readArgs(argv, [], ['json']);
  if (args.error || args.rest.length) {
    io.stderr(`team usage: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: usage.invocation
    return 2;
  }
  const now = sources.now();
  const json = args.flags.has('json');
  let loaded: LoadResult;
  try {
    loaded = loadTeamFile(io.cwd, { home: sources.home });
  } catch (error) {
    // A file that exists and cannot be read: the loader's own reason, as a note line, exit 0.
    return outside(io, json, now, [error instanceof Error ? error.message : String(error)]);
  }
  if (!loaded.ok) {
    // No file at all — no repository, or a repository with no team file: outside a project. A
    // file that exists and does not load is this team's own problem: the loader's own message,
    // with the path, as note lines. Exit 0 either way.
    const notes = !loaded.path || !existsSync(loaded.path)
      ? [NO_PROJECT]
      : loaded.errors.map((problem) => noticeOf(loaded.path as string, problem));
    return outside(io, json, now, notes);
  }
  const report = projectUsage(loaded.root, sources.home, now.getTime());
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

/** The loader's own message with the path: how the block reports a file that exists and does
 *  not load — never the bare `no team file here` text, which is a different case's sentence. */
function noticeOf(path: string, problem: Problem): string {
  return `${path}${problem.line ? ` line ${problem.line}` : ''}: ${problem.message}`;
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
