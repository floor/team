// The `information` layer's first reader: what one project's team file, state and approval store
// say about its labs, accounts and windows, in the rows `status` already prints. It reads files
// only — the team file (one that cannot be read falls back to the copy the approval stored), the
// state beside it, the store — and writes nothing at all: no `last_valid` copy, no log line, no
// lock, no state. It runs nothing, reads no pane, no vendor file, no vendor key.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { budgetsInForceOf, watchInForceOf } from '../approve/approval.ts';
import { checkOf, countedFor, recall, recallSpend, screenOf, type Seen, type SpendReading } from '../budgets/readings.ts';
import { budgetTable, reserveOf, sourcesOf, type BudgetRow } from '../budgets/table.ts';
import { TEAM_FILE } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { readState, type State } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';

/** The line a team's rows read when neither its file nor an approved copy of it can be read. */
export const NO_FIGURES = 'no figures (the file could not be read)';

/** Whether a watch is recording for a project, by the state's own record (design note § 1.4). */
export type WatchRecording = 'recording' | 'not-recording' | 'not-known';

/** One row of a project's table, and the moment behind the figure it counts: the numeric
 *  `changedAt` a machine-scope reader orders by, null when no reading counted for the row. */
export type UsageRow = { row: BudgetRow; changedAt: number | null };

export type ProjectUsage = {
  /** The project's name; null when neither its file nor an approved copy could be read. */
  project: string | null;
  rows: UsageRow[];
  /** The spend checks' readings, as the state holds them (§ 5). Read here, printed from S2 on. */
  spend: SpendReading[];
  watch: WatchRecording;
  /** What the block prints as its `note:` lines: the state's own reason, path and all. */
  notes: string[];
};

/**
 * One project's block: the accounts its budgets in force name, and any reading its state still
 * holds, each row exactly as `status` builds it. The team file is read through
 * `validateTeamFile`; a file that cannot be read falls back to the copy its approval stored; when
 * neither can be read, `project` is null and there are no rows (`NO_FIGURES`). The state is read
 * once and never written, and nothing here opens a lock, a pane, a vendor file or a key.
 */
export function projectUsage(root: string, home: string = homedir(), now: number = Date.now()): ProjectUsage {
  const standing = approvalStanding(root, home);
  const team = teamOf(root, standing, home);
  const notes: string[] = [];
  let readings: Seen[] = [];
  let spend: SpendReading[] = [];
  let state: State | null = null;
  try {
    state = readState(join(root, '.agents'));
    readings = recall(state.budgets);
    spend = recallSpend(state.spend);
  } catch (error) {
    // The state's own reason, path and all: the block prints it as a note line (§ 2.3).
    notes.push(error instanceof Error ? error.message : String(error));
  }
  if (team === null) return { project: null, rows: [], spend: [], watch: 'not-known', notes };
  const budgets = budgetsInForceOf(standing, team);
  const rows = budgetTable(budgets, readings, now).map((row) => ({ row, changedAt: countedMoment(budgets, readings, row, now) }));
  return {
    project: team.project,
    rows,
    spend,
    watch: recordedWatch(state, team, watchInForceOf(standing, team), now),
    notes,
  };
}

/** The team file at the root as the layer reads it: the file itself through `validateTeamFile`,
 *  and the copy the approval stored when the file cannot be read (§ 2.1). */
function teamOf(root: string, standing: Standing, home: string): TeamFile | null {
  const live = readText(join(root, TEAM_FILE));
  if (live !== null) {
    const checked = validateTeamFile(live, { home, root });
    if (checked.ok) return checked.team;
  }
  if (standing.kind !== 'verified') return null;
  const stored = validateTeamFile(standing.record.file);
  return stored.ok ? stored.team : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The moment behind a row's figure: the same rule that chose the figure, over the same group
 *  `budgetTable` built the row from, so the two can never drift apart. Null for a blank row or
 *  one nothing counted for. */
function countedMoment(budgets: TeamFile['budgets'], list: readonly Seen[], row: BudgetRow, now: number): number | null {
  const group = list.filter((reading) => reading.account === row.account && reading.window === row.window);
  if (group.length === 0) return null;
  const result = countedFor(
    sourcesOf(budgets, row.account),
    screenOf(group),
    checkOf(group),
    now,
    budgets.staleAfter * 1000,
    reserveOf(budgets, row.account),
  );
  return result.kind === 'unknown' ? null : result.reading.changedAt;
}

/** § 1.4's rule, in the tool's existing words: a record whose heartbeat is no older than two
 *  in-force intervals is a watch that is recording; no record is a watch that is not; a state
 *  that cannot be read, or a heartbeat that cannot, leaves it not known either way. */
function recordedWatch(state: State | null, team: TeamFile, watch: TeamFile['watch'], now: number): WatchRecording {
  if (state === null) return 'not-known';
  const recorded = state.sessions[team.session]?.watch;
  if (!recorded) return 'not-recording';
  const beat = typeof recorded.heartbeat === 'string' ? Date.parse(recorded.heartbeat) : Number.NaN;
  if (!Number.isFinite(beat)) return 'not-known';
  return (now - beat) / 1000 <= 2 * watch.interval ? 'recording' : 'not-recording';
}
