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
  // The watch's own timings, thresholds included: a seat allowed to stretch `unsent_after` or
  // `idle_first` could silence the watch itself, so the section is the owner's like the rest.
  'watch',
  // And turning a check off is the finer line inside it: the digest above leaves the checks out,
  // so turning one off reads as `watch.checks` alone, never as a threshold change too.
  'watch.checks',
] as const;

/** One owner section, read from the file; the two watch sections sit inside `watch`, not at the top. */
function sectionOf(team: Approvable, name: string): unknown {
  if (name === 'watch.checks') return (team.watch as { checks?: unknown } | undefined)?.checks ?? [];
  if (name === 'watch') {
    const watch = team.watch as Record<string, unknown> | null | undefined;
    if (watch === null || watch === undefined) return undefined;
    const rest = { ...watch };
    delete rest.checks;
    return rest;
  }
  return team[name];
}

/**
 * Seat fields that change without a new approval: where the seat sits in the
 * file, and how its entry is written (`count: 3` becoming `count: 2`, or
 * explicit seats, when one is taken out). `parked` and `stopped` stay in the
 * digest: a seat that can edit the file must not silence itself. `remove --keep`
 * and `add` record the new digest with the edit.
 */
const SEAT_FREE_FIELDS = new Set(['line', 'declared', 'count', 'instance']);

/** The free set from before `parked` and `stopped` joined the digest. */
const LEGACY_SEAT_FREE_FIELDS = new Set(['parked', 'stopped', 'line', 'declared', 'count', 'instance']);

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
  for (const seat of team.seats) seats[seat.name] = seatDigest(seat, SEAT_FREE_FIELDS);
  return { sections, seats };
}

/**
 * Seat digests as a record written before `parked` and `stopped` were part of
 * them. An approval from then still matches a file that has not changed.
 */
export function legacySeatDigests(team: Approvable): Record<string, string> {
  const seats: Record<string, string> = {};
  for (const seat of team.seats) seats[seat.name] = seatDigest(seat, LEGACY_SEAT_FREE_FIELDS);
  return seats;
}

function seatDigest(seat: Record<string, unknown>, free: Set<string>): string {
  const fields = Object.fromEntries(Object.entries(seat).filter(([key]) => !free.has(key)));
  return digest(fields);
}

export type Difference =
  { kind: 'section'; name: string } | { kind: 'seat-changed'; name: string } | { kind: 'seat-new'; name: string };

/**
 * What in the file the owner has not approved. The file passes when every
 * section matches and every seat in it matches an approved seat: a seat taken
 * out needs no new approval. Parking or stopping one does.
 */
export function compare(approved: Fingerprints, current: Fingerprints): Difference[] {
  const differences: Difference[] = [];
  for (const name of OWNER_SECTIONS) {
    // A record with no fingerprint for a section is read by `approvedFingerprints`, from the copy
    // it stored. What reaches here without one is a record whose copy is gone: it turned nothing
    // off, so `watch.checks` reads as the empty list, and a missing `watch` is a difference.
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
