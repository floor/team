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
] as const;

/** Seat fields that `remove --keep`, `add` and the layout change without a new approval. */
const SEAT_FREE_FIELDS = new Set(['parked', 'stopped', 'line']);

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
  for (const section of OWNER_SECTIONS) sections[section] = digest(team[section]);

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
    if (approved.sections[name] !== current.sections[name]) differences.push({ kind: 'section', name });
  }
  for (const [name, fingerprint] of Object.entries(current.seats)) {
    if (!Object.hasOwn(approved.seats, name)) differences.push({ kind: 'seat-new', name });
    else if (approved.seats[name] !== fingerprint) differences.push({ kind: 'seat-changed', name });
  }
  return differences;
}

/** One line per difference, as `status`, `doctor` and the refusals print it. */
export function describe(difference: Difference): string {
  if (difference.kind === 'section') return `\`${difference.name}\` changed`;
  if (difference.kind === 'seat-new') return `seat ${difference.name} is not in the approved file`;
  return `seat ${difference.name} changed`;
}
