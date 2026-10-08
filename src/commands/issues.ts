// `team issues`: list the typed records of the one task source the team file names.
// The source is a file the owner committed. No command in this build contacts a tracker.
// The broker is not built. Credential-withholding is not this slice. There is no tracker
// credential here to withhold. A listing is not a claim and not the intake rule.
import { readArgs } from '../args.ts';
import { findRoot, loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import type { TaskAdapter, TaskRecord } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';

export const USAGE = 'Usage: team issues\n';

export type IssuesSources = {
  home?: string;
  /** Injected the way a watch's sources are. The shipped registry is the file adapter alone. */
  registry?: Record<string, TaskAdapter>;
};

export const issues: Command = (argv, io) => runIssues(argv, io);
export default issues;

export async function runIssues(argv: string[], io: Io, sources: IssuesSources = {}): Promise<number> {
  const args = readArgs(argv, [], []);
  if (args.error || args.rest.length) {
    io.stderr(`team issues: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: issues.invocation
    return 2;
  }
  const root = findRoot(io.cwd);
  if (!root) {
    io.stderr(`team issues: ${NOT_A_REPO}\n`);
    // exit: issues.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors[0]?.message ?? 'the team file can\'t be read';
    return refuse(io, 'file', message);
  }
  if (!loaded.team.tasks) return refuse(io, 'file', 'the team file declares no task source');
  const registry = sources.registry ?? fileRegistry;
  const adapter = registry[loaded.team.tasks.source];
  if (!adapter) return refuse(io, 'file', 'tasks.source must be file');
  const read = adapter.read({ root: loaded.root, path: loaded.team.tasks.path });
  if (read.kind === 'missing') return refuse(io, 'missing', 'the task file is not there');
  if (read.kind === 'outside') return refuse(io, 'file', 'tasks.path must stay inside the checkout');
  if (read.kind === 'not-a-list') {
    io.stderr('team issues: the task file is not a list\n');
    return shape();
  }
  if (read.records.length === 0 && read.refusals.length === 0) {
    io.stdout('team issues: nothing is waiting\n');
    // exit: issues.none
    return 0;
  }
  if (read.records.length) io.stdout(format(read.records));
  if (read.refusals.length) {
    for (const refusal of read.refusals) {
      const who = refusal.id ?? `record ${refusal.index}`;
      io.stderr(`team issues: ${who} is not a task: ${refusal.reason}\n`);
    }
    return shape();
  }
  // exit: issues.shown
  return 0;
}

function shape(): number {
  // exit: issues.shape
  return 1;
}

function refuse(io: Io, kind: 'file' | 'missing', message: string): number {
  io.stderr(`team issues: ${message}\n`);
  if (kind === 'missing') {
    // exit: issues.missing
    return 1;
  }
  // exit: issues.file
  return 1;
}

/** One trailing newline is the block-scalar ending, not a blank line to print. */
function descriptionLines(value: string): string[] {
  const shown = value.endsWith('\n') ? value.slice(0, -1) : value;
  const parts = shown.split('\n');
  const lines = [`  description: ${parts[0] ?? ''}`];
  for (const part of parts.slice(1)) lines.push(part === '' ? '' : `    ${part}`);
  return lines;
}

function format(records: readonly TaskRecord[]): string {
  const blocks = records.map((record) => {
    const lines = [`${record.id}  ${record.title}`];
    if (record.priority !== undefined) lines.push(`  priority: ${record.priority}`);
    if (record.assignee !== undefined) lines.push(`  assignee: ${record.assignee}`);
    if (record.milestone !== undefined) lines.push(`  milestone: ${record.milestone}`);
    if (record.deadline !== undefined) lines.push(`  deadline: ${record.deadline}`);
    if (record.blockedBy && record.blockedBy.length) lines.push(`  blocked-by: ${record.blockedBy.join(', ')}`);
    if (record.repos && record.repos.length) lines.push(`  repos: ${record.repos.join(', ')}`);
    if (record.needs && record.needs.length) lines.push(`  needs: ${record.needs.join(', ')}`);
    if (record.description !== undefined) lines.push(...descriptionLines(record.description));
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}
