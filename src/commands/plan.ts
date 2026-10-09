// `team plan`: print the queue a claim would consider, in `team next`'s order — the same seat
// gate, the same read, the same ordering, against this clone's clock. It is a listing: it claims
// nothing and writes no lease, so a record another seat holds can still appear. A deadline the
// clock has passed is marked `(overdue)` here; the mark decides nothing — an overdue record is
// still takeable and is never dropped, blocked, reordered or released by lateness.
import { readArgs } from '../args.ts';
import { askBroker, DEADLINE, NOT_RUNNING, WRONG_ANSWER } from '../broker/client.ts';
import type { BrokerRequest } from '../broker/protocol.ts';
import { findRoot, loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import type { TaskAdapter, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';
import { formatRecords } from '../tasks/format.ts';
import { order, place, takeable } from './next.ts';

export const USAGE = 'Usage: team plan\n';

export type PlanSources = {
  home?: string;
  /** Injected the way `team next`'s sources are. The shipped registry is the file adapter alone. */
  registry?: Record<string, TaskAdapter>;
  now?: () => number;
  /** The broker client's deadline, injected the way the release check injects its timeout: a
   *  test shortens it instead of hanging. Production leaves it at the client's own. */
  deadlineMs?: number;
};

export const plan: Command = (argv, io) => runPlan(argv, io);
export default plan;

export async function runPlan(argv: string[], io: Io, sources: PlanSources = {}): Promise<number> {
  const args = readArgs(argv, [], []);
  if (args.error || args.rest.length) {
    return invocation(io, args.error ?? `unexpected "${args.rest[0]}"`, true);
  }
  const root = findRoot(io.cwd);
  if (!root) {
    io.stderr(`team plan: ${NOT_A_REPO}\n`);
    // exit: plan.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) return file(io, loaded.errors[0]?.message ?? 'the team file can\'t be read');
  const tasks = loaded.team.tasks;
  if (!tasks) return file(io, 'the team file declares no task source');
  if (tasks.source === 'linear') {
    return planFromBroker(io, loaded, tasks, sources);
  }
  const registry = sources.registry ?? fileRegistry;
  const adapter = registry[tasks.source];
  if (!adapter) return file(io, 'tasks.source must be file');
  const placed = place(loaded.team, loaded.root, io);
  if (placed.kind === 'refused') return callerRefuse(io, placed.message);
  const read = adapter.read({ root: loaded.root, path: tasks.path });
  if (read.kind === 'missing') return missing(io);
  if (read.kind === 'outside') return file(io, 'tasks.path must stay inside the checkout');
  if (read.kind === 'not-a-list') {
    io.stderr('team plan: the task file is not a list\n');
    return shape();
  }
  return show(io, read, placed.seat, tasks.pull ?? 'self', tasks.fallback ?? 'file', sources.now ?? Date.now);
}

/**
 * The broker source: the same gate and the same read `team next` asks — one request line and one
 * answer line — and no claim of any kind on either side. Every failure is a refusal.
 */
async function planFromBroker(
  io: Io,
  loaded: { team: TeamFile; root: string },
  tasks: Extract<NonNullable<TeamFile['tasks']>, { source: 'linear' }>,
  sources: PlanSources,
): Promise<number> {
  const placed = place(loaded.team, loaded.root, io);
  if (placed.kind === 'refused') return callerRefuse(io, placed.message);
  const request: BrokerRequest = { op: 'read', seat: placed.seat, pane: placed.pane };
  const options = sources.deadlineMs === undefined ? {} : { deadlineMs: sources.deadlineMs };
  const outcome = await askBroker(loaded.root, request, options);
  if (outcome.kind === 'unavailable') return broker(io, NOT_RUNNING);
  if (outcome.kind === 'wrong') return broker(io, WRONG_ANSWER);
  if (outcome.kind === 'deadline') return broker(io, DEADLINE);
  if (outcome.kind === 'refused') {
    if (outcome.at === 'caller') return callerRefuse(io, outcome.message);
    return readFail(io, outcome.message);
  }
  // This build's broker answers records for a linear source; any other read kind is an answer
  // the seat fails safe on, exactly like an unparseable line.
  if (outcome.read.kind !== 'records') return broker(io, WRONG_ANSWER);
  if (outcome.notice !== undefined) io.stderr(`team plan: ${outcome.notice}\n`);
  return show(io, outcome.read, placed.seat, tasks.pull ?? 'self', tasks.fallback ?? 'file', sources.now ?? Date.now);
}

/**
 * One pass of the read path — the takeable records, ordered — with no claim and no write. A
 * refusal in the read is named on stderr and is not a candidate; the printed block is the issues
 * block, with a deadline the clock has passed marked overdue. A held record still appears: it is
 * in the queue a claim would consider, and this command claims nothing.
 */
function show(
  io: Io,
  read: { records: readonly TaskRecord[]; refusals: readonly TaskRefusal[] },
  seat: string,
  pull: 'self' | 'any',
  fallback: 'file' | 'id',
  now: () => number,
): number {
  for (const refusal of read.refusals) {
    const who = refusal.id ?? `record ${refusal.index}`;
    io.stderr(`team plan: ${who} is not a task: ${refusal.reason}\n`);
  }
  const candidates = order(takeable(read.records, seat, pull, false), fallback);
  if (candidates.length) {
    io.stdout(formatRecords(candidates, now()));
    // exit: plan.shown
    return 0;
  }
  if (read.refusals.length) return shape();
  return none(io);
}

function invocation(io: Io, message: string, usage: boolean): number {
  io.stderr(`team plan: ${message}\n${usage ? USAGE : ''}`);
  // exit: plan.invocation
  return 2;
}

function file(io: Io, message: string): number {
  io.stderr(`team plan: ${message}\n`);
  // exit: plan.file
  return 1;
}

function missing(io: Io): number {
  io.stderr('team plan: the task file is not there\n');
  // exit: plan.missing
  return 1;
}

function shape(): number {
  // exit: plan.shape
  return 1;
}

function callerRefuse(io: Io, message: string): number {
  io.stderr(`team plan: ${message}\n`);
  // exit: plan.caller
  return 1;
}

function broker(io: Io, message: string): number {
  io.stderr(`team plan: ${message}\n`);
  // exit: plan.broker
  return 1;
}

function readFail(io: Io, message: string): number {
  io.stderr(`team plan: ${message}\n`);
  // exit: plan.read
  return 1;
}

function none(io: Io): number {
  io.stdout('team plan: nothing is takeable\n');
  // exit: plan.none
  return 0;
}
