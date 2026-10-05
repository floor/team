import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { approvalCase, budgetsInForceOf, watchInForceOf } from '../approve/approval.ts';
import { overridesInForceOf, type OverrideForce } from '../profiles/overrides.ts';
import { readArgs } from '../args.ts';
import { budgetLine, budgetTable, type BudgetRow } from '../budgets/table.ts';
import { recall } from '../budgets/readings.ts';
import { currentTeam } from '../file/current.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import { agentList, paneRead, sessionRunning, workspaceList } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { emptySession, readState } from '../state.ts';
import { keyFingerprint, keyState } from '../store/keys.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { compare, isOwnerRepair, orderAndAnnotateDifferences } from '../status/compare.ts';
import type { Comparison, Difference, Live } from '../status/compare.ts';

// What `status` reads from outside the file and the state, so tests can stand in for it.
export type StatusSources = {
  live(session: string, team: TeamFile): Live | null;
  branch(path: string): string | null;
  // The approval store's one snapshot, read once for the whole report: the
  // drift, the watch and budget values in force, and the overrides all derive
  // from it, so no later read can disagree with the first.
  standing(root: string): Standing;
  now(): Date;
  /** The home whose store holds the override file and the key. Absent in a test that does not set one. */
  home?: string;
};

/**
 * The standing source against a home that is not the owner's real one — the
 * shipped command's own, and what a test or a scratch home stands in for.
 */
export function standingSource(home: string): StatusSources['standing'] {
  return (root) => approvalStanding(root, home);
}

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
  standing: standingSource(homedir()),
  now: () => new Date(),
  home: homedir(),
};

export const status: Command = (argv, io) => runStatus(argv, io, realSources);
export default status;

/**
 * The JSON shape printed by `team status --json`.
 * Format 1.
 */
export interface StatusJson {
  format: 1;
  project: string;
  session: string;
  rows: Array<{
    name: string;
    state: string;
    model: string;
    pane: string;
  }>;
  notes: string[];
  differences: Array<{
    what: string;
    repair: string;
  }>;
  notice: string | null;
  /** Present when the file names an account, or a reading is stored. */
  budgets?: BudgetRow[];
}

export const USAGE = 'Usage: team status [--session <name>] [--file <path>] [--json]\n';

export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['json']);
  if (args.error || args.rest.length) {
    io.stderr(`team status: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: status.invocation
    return 2;
  }

  const current = currentTeam(io.cwd, args.values.file, sources.now());
  if (!current.ok) {
    printProblems(io, current.errors);
    // exit: status.not-a-repo
    // exit: status.file
    // exit: status.file-invalid
    return 2;
  }
  const { team, root, dir } = current;
  if (!args.flags.has('json') && current.notice) io.stdout(`${current.notice}\n`);
  for (const warning of current.warnings) io.stderr(`team status: warning, line ${warning.line}: ${warning.message}\n`);

  const session = args.values.session ?? team.session;
  // The one read of the approval store: everything below derives from it.
  const standing = sources.standing(root);
  const overrides = sources.home ? overridesInForceOf(standing, team.project, root, sources.home) : emptyOverrides();
  for (const problem of overrides.problems) io.stderr(`team status: ${problem}\n`);
  const live = sources.live(session, team);
  if (!live) {
    io.stderr('team status: herdr doesn\'t answer; is it installed and running?\n');
    // exit: status.herdr
    return 2;
  }
  const whole = readState(dir);
  const state = whole.sessions[session] ?? emptySession();
  const budgets = budgetTable(budgetsInForceOf(standing, team), recall(whole.budgets), sources.now().getTime());
  const comparison = compare(team, session, state, live, sources.now(), watchInForceOf(standing, team));
  if (standing.kind === 'verified') {
    const key = sources.home ? keyState(sources.home) : { kind: 'missing' as const };
    const ofKey = key.kind === 'key' ? `, key ${keyFingerprint(key.key)}` : '';
    comparison.notes.unshift(`approval #${standing.generation} (${standing.signedAt.slice(0, 10)})${ofKey}`);
  }
  if (!live.running) comparison.notes.unshift(`the herdr session "${session}" is not running`);
  comparison.differences = orderAndAnnotateDifferences([
    ...comparison.differences,
    ...protectedCheckouts(team, root, sources),
    ...approvalDrift(approvalCase(standing, team)),
    ...overrideDrift(overrides),
  ]);

  if (args.flags.has('json')) {
    const doc: StatusJson = {
      format: 1,
      project: team.project,
      session,
      rows: comparison.rows,
      notes: comparison.notes,
      differences: comparison.differences,
      notice: current.notice ?? null,
      ...(budgets.length ? { budgets } : {}),
    };
    io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    io.stdout(render(team, session, comparison, budgets));
  }
  // exit: status.agrees
  // exit: status.difference
  return comparison.differences.length ? 1 : 0;
}

function emptyOverrides(): OverrideForce {
  return { profiles: [], differences: [], problems: [] };
}

function overrideDrift(report: OverrideForce): Difference[] {
  return [
    ...report.differences.map((line) => ({
      what: `the overrides differ from the approved copy: ${line}`,
      repair: 'the owner runs team approve',
    })),
    ...report.problems.map((problem) => ({ what: problem, repair: 'fix the overrides file' })),
  ];
}

// A file that was never approved, or was changed since, runs nothing until the owner approves it.
// A legacy or refused record is the whole case and its repair in one line of its own.
export function approvalDrift(approval: { differences: string[] | null; reason: string | null }): Difference[] {
  if (approval.reason !== null) return [{ what: approval.reason, repair: 'the owner runs team approve' }];
  if (approval.differences === null) {
    return [{ what: 'the file was never approved on this machine', repair: 'the owner runs team approve' }];
  }
  return approval.differences.map((line) => ({ what: `the file differs from the approved one: ${line}`, repair: 'the owner runs team approve' }));
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

function render(team: TeamFile, session: string, comparison: Comparison, budgets: BudgetRow[]): string {
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
  if (budgets.length) {
    lines.push('budgets:');
    // The row carries its own reserve: the line and the JSON can't disagree (queue 79).
    for (const row of budgets) lines.push(`  ${budgetLine(row)}`);
  }
  for (const note of comparison.notes) lines.push(`note: ${note}`);
  for (const difference of comparison.differences) {
    lines.push(`difference: ${difference.what}`, `  repair: ${difference.repair}`);
  }
  const ownerCount = comparison.differences.filter((d) => isOwnerRepair(d.repair)).length;
  if (ownerCount > 0) {
    lines.push(`${comparison.differences.length} difference(s), ${ownerCount} for the owner`);
  } else {
    lines.push(`${comparison.differences.length} difference(s)`);
  }
  return `${lines.join('\n')}\n`;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team status: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}
