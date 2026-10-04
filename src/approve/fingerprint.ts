import { createHash } from 'node:crypto';

/**
 * The sections only the owner changes. An edit to any of them needs a new
 * approval before the file runs.
 */
export const OWNER_SECTIONS = [
  'trust',
  'limits',
  'machine',
  'rules',
  'identity',
  'workspace',
  'coordinator',
  'operator',
  'session',
  'visibility',
  'tools',
  'budgets',
  // Turning a watch check off is the owner's, and only theirs: the file's checks are digested
  // where they stand, under `watch`, so a section of their own.
  'watch.checks',
] as const;

/** One owner section, read from the file; `watch.checks` sits inside `watch`, not at the top. */
function sectionOf(team: Approvable, name: string): unknown {
  if (name === 'watch.checks') return (team.watch as { checks?: unknown } | undefined)?.checks ?? [];
  return team[name];
}

/**
 * Seat fields that change without a new approval: what `remove --keep` and
 * `add` set, where the seat sits in the file, and how its entry is written
 * (`count: 3` becoming `count: 2`, or explicit seats, when one is taken out).
 */
const SEAT_FREE_FIELDS = new Set(['parked', 'stopped', 'line', 'declared', 'count', 'instance']);

/** A validated team file, as far as an approval reads it. */
export type Approvable = Record<string, unknown> & {
  seats: readonly (Record<string, unknown> & { name: string })[];
};

export interface Fingerprints {
  sections: Record<string, string>;
  /** By seat name, after `count` is expanded. */
  seats: Record<string, string>;
}

/** JSON with every object's keys in order, so equal values give equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** A fingerprint of each owner-only section and of each seat. */
export function fingerprints(team: Approvable): Fingerprints {
  const sections: Record<string, string> = {};
  for (const section of OWNER_SECTIONS) sections[section] = digest(sectionOf(team, section));

  const seats: Record<string, string> = {};
  for (const seat of team.seats) {
    const fields = Object.fromEntries(Object.entries(seat).filter(([key]) => !SEAT_FREE_FIELDS.has(key)));
    seats[seat.name] = digest(fields);
  }
  return { sections, seats };
}

export type Difference =
  { kind: 'section'; name: string } | { kind: 'seat-changed'; name: string } | { kind: 'seat-new'; name: string };

/**
 * What in the file the owner has not approved. The file passes when every
 * section matches and every seat in it matches an approved seat: a seat taken
 * out, parked or stopped needs no new approval.
 */
export function compare(approved: Fingerprints, current: Fingerprints): Difference[] {
  const differences: Difference[] = [];
  for (const name of OWNER_SECTIONS) {
    // An approval recorded before `watch.checks` existed approved a file that turned nothing off:
    // read it that way, so the section's arrival alone is not a difference.
    const before = approved.sections[name] ?? (name === 'watch.checks' ? digest([]) : undefined);
    if (before !== current.sections[name]) differences.push({ kind: 'section', name });
  }
  for (const [name, fingerprint] of Object.entries(current.seats)) {
    if (!Object.hasOwn(approved.seats, name)) differences.push({ kind: 'seat-new', name });
    else if (approved.seats[name] !== fingerprint) differences.push({ kind: 'seat-changed', name });
  }
  return differences;
}

/**
 * The line `describe` prints when `watch.checks` itself is the difference. `pass` reads it to
 * keep the checks running until the owner approves an edit that would turn one off: nothing is
 * turned off until the owner approves (RFC 0002 § 4.2).
 */
export const WATCH_CHECKS_CHANGED = '`watch.checks` changed';

/** One line per difference, as `status`, `doctor` and the refusals print it. */
export function describe(difference: Difference): string {
  if (difference.kind === 'section') return `\`${difference.name}\` changed`;
  if (difference.kind === 'seat-new') return `seat ${difference.name} is not in the approved file`;
  return `seat ${difference.name} changed`;
}
