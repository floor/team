import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { DraftSeat } from './seats.ts';

export function readLead(
  entry: YamlEntry | undefined, field: 'coordinator' | 'operator', seats: DraftSeat[], broken: Set<string>, check: Check,
): string {
  const name = check.required(entry, field, 1);
  if (!name || !entry) return '';
  const seat = seats.find((candidate) => candidate.name === name);
  const line = entry.value.line;
  if (!seat) {
    if (!broken.has(name)) check.fail(line, `${field} "${name}" names no declared seat`);
  }
  else if (seat.count > 1) check.fail(line, `${field} "${name}" can't be a seat with count`);
  else if (seat.parked) check.fail(line, `${field} "${name}" can't be a parked seat`);
  else if (seat.stopped) check.fail(line, `${field} "${name}" can't be a stopped seat`);
  return name;
}
