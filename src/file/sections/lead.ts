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

/** Whether a seat is declared as coordinator or operator in the team file. */
export function isLeadSeat(
  team: { coordinator: string; operator: string },
  name: string,
): boolean {
  return name === team.coordinator || name === team.operator;
}

/**
 * The relaunch repair command for a seat `up` leaves as it is:
 * for a coordinator or operator, `remove --keep` is refused because leads cannot be stopped,
 * so only `team down` then `team up` (to restart the whole team) is offered.
 * For ordinary seats, both the per-seat and whole-team sequence are offered.
 */
export function relaunchRepair(
  team: { coordinator: string; operator: string },
  name: string,
  mode: 'markdown' | 'plain' = 'markdown',
): string {
  const lead = isLeadSeat(team, name);
  if (mode === 'markdown') {
    return lead
      ? '`team down` then `team up` (to restart the whole team)'
      : `\`team remove ${name} --keep\` then \`team add ${name}\` (or \`team down\` then \`team up\` for the whole team)`;
  }
  return lead
    ? 'team down, then team up (to restart the whole team)'
    : `team remove ${name} --keep, then team add ${name} (or team down, then team up, for the whole team)`;
}
