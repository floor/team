// The per-field policy: which fields of a record cross the broker's boundary. Applied in the
// broker, after the adapter builds the record, before the answer is serialized — seat-side
// filtering would be theater, because the bytes would already have crossed into the seat's
// process. An omitted field is absent from the record, never blank (`team next` and `team
// issues` print present fields only). `id` and `title` are the record itself: the validator
// refuses an `allow` that does not name both and an `omit` that names either, and `applyPolicy`
// keeps the two regardless, so the invariant holds whichever way it is called.
import type { TaskRecord } from '../tasks/adapter.ts';

/** Every task-field name the team file may write, in the task file's own spelling. */
export const TASK_FIELDS = [
  'id',
  'title',
  'priority',
  'assignee',
  'milestone',
  'deadline',
  'blocked-by',
  'repos',
  'needs',
  'description',
] as const;

export type TaskField = (typeof TASK_FIELDS)[number];

/** As parsed from the team file: omitted keys stay absent, never materialized. */
export type TaskPolicy = {
  allow?: TaskField[];
  omit?: TaskField[];
  transform?: { id: 'bare' };
};

/** The default set: the nine typed fields. `description` crosses only when `allow` names it. */
const DEFAULT_FIELDS: TaskField[] = ['id', 'title', 'priority', 'assignee', 'milestone', 'deadline', 'blocked-by', 'repos', 'needs'];

export function applyPolicy(record: TaskRecord, policy?: TaskPolicy): TaskRecord {
  const named = policy?.allow ?? DEFAULT_FIELDS.filter((field) => !(policy?.omit ?? []).includes(field));
  const crosses = new Set<TaskField>([...named, 'id', 'title']);
  const out: TaskRecord = { id: record.id, title: record.title };
  if (crosses.has('priority') && record.priority !== undefined) out.priority = record.priority;
  if (crosses.has('assignee') && record.assignee !== undefined) out.assignee = record.assignee;
  if (crosses.has('milestone') && record.milestone !== undefined) out.milestone = record.milestone;
  if (crosses.has('deadline') && record.deadline !== undefined) out.deadline = record.deadline;
  if (crosses.has('blocked-by') && record.blockedBy !== undefined) out.blockedBy = record.blockedBy;
  if (crosses.has('repos') && record.repos !== undefined) out.repos = record.repos;
  if (crosses.has('needs') && record.needs !== undefined) out.needs = record.needs;
  if (crosses.has('description') && record.description !== undefined) out.description = record.description;
  if (policy?.transform?.id === 'bare') out.id = bareId(record.id);
  return out;
}

/** The RFC's own example made real: an id that arrives as its source URL crosses as its last
 *  `/`-separated segment, so the tracker's host never rides into the record. An id already
 *  bare is unchanged. */
function bareId(id: string): string {
  return bareRefusalId(id) ?? id;
}

/** The refusal side of the same rule: what a refusal's `id` crosses as. The id is the source's
 *  own reference, not a credential, so the transform governs the refusal's id too (the broker
 *  calls this where the read is filtered). An id with no segment to cross answers undefined —
 *  the caller omits the id rather than sending the raw one. */
export function bareRefusalId(id: string): string | undefined {
  const segments = id.split('/').filter((segment) => segment !== '');
  return segments.at(-1);
}
