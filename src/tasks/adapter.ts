// The typed task record and the adapter a `team issues` read goes through. This slice registers
// one adapter, `file`. A later source is a new module, a registry row, and the validator's
// allowed name — the command keeps calling `read`.

/** RFC 008's typed record. Only `id` and `title` are required; an omitted field is absent. */
export type TaskRecord = {
  id: string;
  title: string;
  priority?: string | number;
  assignee?: string;
  milestone?: string;
  deadline?: string;
  /** Present and empty when the source wrote an empty list. Absent when the source omitted it. */
  blockedBy?: string[];
  repos?: string[];
  needs?: string[];
  description?: string;
};

/** One record the adapter refused. `index` is the 1-based place in the source. `id` is set only when the id itself was accepted. */
export type TaskRefusal = { index: number; id?: string; reason: string };

export type TaskRead =
  | { kind: 'missing' }
  | { kind: 'not-a-list' }
  | { kind: 'outside' }
  | { kind: 'records'; records: TaskRecord[]; refusals: TaskRefusal[] };

export type TaskReadInput = { root: string; path: string };

export type TaskClaimInput = {
  root: string;
  path: string;
  record: TaskRecord;
  seat: string;
  pane: string;
  now: number;
};

/** `held` prints the record and writes no local lease. `busy` is skipped, the way a live lease is. */
export type TaskClaimResult = { kind: 'held' } | { kind: 'busy' };

export type TaskReleaseInput = { root: string; seat: string; pane: string; now: number };

export type TaskReleaseResult = { kind: 'released'; id: string } | { kind: 'none' };

export interface TaskAdapter {
  name: string;
  read(input: TaskReadInput): TaskRead;
  /** Absent on the file adapter: the local lease runs. A tracker claim does not also write one. */
  claim?(input: TaskClaimInput): TaskClaimResult;
  /** Absent on the file adapter: the local lease file is released. */
  release?(input: TaskReleaseInput): TaskReleaseResult;
}
