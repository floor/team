// `team next`: claim one record from the file the owner committed, with a lease in this clone.
// The source is a file the owner committed. No command in this build contacts a tracker.
// The broker is not built. Credential-withholding is not this slice. There is no tracker
// credential here to withhold. `team plan` is not a command.
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../caller.ts';
import { findRoot, loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import type { TaskAdapter, TaskRecord } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';
import { formatRecords } from '../tasks/format.ts';
import { claimLocal, releaseLocal } from '../tasks/lease.ts';

export const USAGE = 'Usage: team next [--mine | --release]\n';

export type NextSources = {
  home?: string;
  /** Injected the way a watch's sources are. The shipped registry is the file adapter alone. */
  registry?: Record<string, TaskAdapter>;
  now?: () => number;
};

export const next: Command = (argv, io) => runNext(argv, io);
export default next;

export async function runNext(argv: string[], io: Io, sources: NextSources = {}): Promise<number> {
  const args = readArgs(argv, [], ['mine', 'release']);
  if (args.flags.has('mine') && args.flags.has('release')) {
    return invocation(io, '--mine and --release are not used together', false);
  }
  if (args.error || args.rest.length) {
    return invocation(io, args.error ?? `unexpected "${args.rest[0]}"`, true);
  }
  const root = findRoot(io.cwd);
  if (!root) {
    io.stderr(`team next: ${NOT_A_REPO}\n`);
    // exit: next.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) return file(io, loaded.errors[0]?.message ?? 'the team file can\'t be read');
  const tasks = loaded.team.tasks;
  if (!tasks) return file(io, 'the team file declares no task source');
  const registry = sources.registry ?? fileRegistry;
  const adapter = registry[tasks.source];
  if (!adapter) return file(io, 'tasks.source must be file');
  const placed = place(loaded.team, loaded.root, io);
  if (placed.kind === 'refused') return callerRefuse(io, placed.message);
  const now = sources.now ?? Date.now;
  const at = now();
  if (args.flags.has('release')) {
    const result = adapter.release
      ? adapter.release({ root: loaded.root, seat: placed.seat, pane: placed.pane, now: at })
      : releaseLocal(loaded.root, placed.seat, placed.pane, at);
    if (result.kind === 'released') return released(io, result.id);
    return none(io, 'nothing is held');
  }
  const read = adapter.read({ root: loaded.root, path: tasks.path });
  if (read.kind === 'missing') return missing(io);
  if (read.kind === 'outside') return file(io, 'tasks.path must stay inside the checkout');
  if (read.kind === 'not-a-list') {
    io.stderr('team next: the task file is not a list\n');
    return shape();
  }
  const pull = tasks.pull ?? 'self';
  const fallback = tasks.fallback ?? 'file';
  const mine = args.flags.has('mine');
  const known = new Map(read.records.map((record) => [record.id, record]));
  const candidates = order(takeable(read.records, placed.seat, pull, mine), fallback);
  let outcome: { kind: 'held'; record: TaskRecord } | { kind: 'none' } | { kind: 'kept' };
  if (adapter.claim) {
    let held: TaskRecord | undefined;
    for (const record of candidates) {
      const result = adapter.claim({ root: loaded.root, path: tasks.path, record, seat: placed.seat, pane: placed.pane, now: at });
      if (result.kind === 'held') {
        held = record;
        break;
      }
    }
    outcome = held ? { kind: 'held', record: held } : { kind: 'none' };
  } else {
    outcome = claimLocal(loaded.root, { now: at, seat: placed.seat, pane: placed.pane, known, candidates });
  }
  for (const refusal of read.refusals) {
    const who = refusal.id ?? `record ${refusal.index}`;
    io.stderr(`team next: ${who} is not a task: ${refusal.reason}\n`);
  }
  if (outcome.kind === 'held') return taken(io, outcome.record);
  if (read.refusals.length) return shape();
  if (outcome.kind === 'none' && mine) return none(io, 'nothing is assigned to you');
  return none(io, 'nothing is takeable');
}

function place(team: TeamFile, root: string, io: Io): { kind: 'ok'; seat: string; pane: string } | { kind: 'refused'; message: string } {
  const { caller, shown } = judgeCallerOf(io, team.session);
  const named = caller.kind === 'seat' && team.seats.some((seat) => seat.name === caller.name) ? caller : null;
  if (!named) return { kind: 'refused', message: `only a seat of this team pulls a task; this call is ${describeCaller(shown)}` };
  const verdict = callerVerdict(named, named.name, standingOf(join(root, '.agents'), team.session, named));
  if (verdict.kind === 'no-pane') return { kind: 'refused', message: noPaneRefusal(verdict.name) };
  if (verdict.kind === 'another-pane') return { kind: 'refused', message: anotherPaneRefusal(verdict.name, verdict.recordedPane) };
  if (verdict.kind !== 'ok') return { kind: 'refused', message: `only a seat of this team pulls a task; this call is ${describeCaller(shown)}` };
  return { kind: 'ok', seat: named.name, pane: named.pane };
}

function takeable(records: readonly TaskRecord[], seat: string, pull: 'self' | 'any', mine: boolean): TaskRecord[] {
  return records.filter((record) => {
    if (record.blockedBy && record.blockedBy.length) return false;
    if (record.repos && record.repos.length) return false;
    if (record.needs && record.needs.length) return false;
    if (mine) return record.assignee === seat;
    if (pull === 'self') return record.assignee === undefined || record.assignee === seat;
    return true;
  });
}

function order(records: readonly TaskRecord[], fallback: 'file' | 'id'): TaskRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const left = rank(a.record);
      const right = rank(b.record);
      if (left.kind !== right.kind) return left.kind - right.kind;
      if (left.kind === 0 && right.kind === 0 && left.n !== right.n) return left.n - right.n;
      if (left.kind === 1 && right.kind === 1 && left.text !== right.text) return left.text.localeCompare(right.text);
      if (left.kind === 2 && fallback === 'id' && a.record.id !== b.record.id) return a.record.id < b.record.id ? -1 : 1;
      return a.index - b.index;
    })
    .map((item) => item.record);
}

function rank(record: TaskRecord): { kind: 0; n: number } | { kind: 1; text: string } | { kind: 2 } {
  if (typeof record.priority === 'number' && Number.isFinite(record.priority)) return { kind: 0, n: record.priority };
  if (typeof record.priority === 'string') return { kind: 1, text: record.priority };
  return { kind: 2 };
}

function invocation(io: Io, message: string, usage: boolean): number {
  io.stderr(`team next: ${message}\n${usage ? USAGE : ''}`);
  // exit: next.invocation
  return 2;
}

function file(io: Io, message: string): number {
  io.stderr(`team next: ${message}\n`);
  // exit: next.file
  return 1;
}

function missing(io: Io): number {
  io.stderr('team next: the task file is not there\n');
  // exit: next.missing
  return 1;
}

function shape(): number {
  // exit: next.shape
  return 1;
}

function callerRefuse(io: Io, message: string): number {
  io.stderr(`team next: ${message}\n`);
  // exit: next.caller
  return 1;
}

function none(io: Io, sentence: string): number {
  io.stdout(`team next: ${sentence}\n`);
  // exit: next.none
  return 0;
}

function released(io: Io, id: string): number {
  io.stdout(`team next: released ${id}\n`);
  // exit: next.released
  return 0;
}

function taken(io: Io, record: TaskRecord): number {
  io.stdout(formatRecords([record]));
  // exit: next.taken
  return 0;
}
