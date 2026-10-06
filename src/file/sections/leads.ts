import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { Section } from './section.ts';

/** The team's own seats, the ones a `leads` grant can name. */
export type LeadSeat = 'coordinator' | 'operator';

/**
 * The file's `leads` section: the power the owner has handed the team's own seats, or null when
 * the file has no `leads` section and neither seat has it. Today the one power is `abandon`.
 */
export type Leads = { abandon: LeadSeat[] } | null;

const LEAD_SEATS: readonly LeadSeat[] = ['coordinator', 'operator'];

/**
 * Which of the team's leads may pass `--abandon`. Omitted it is null and neither lead has the
 * power; present, it is a map with exactly `abandon`, a non-empty ordered list of distinct seats.
 */
export const leads: Section = {
  name: 'leads',
  owner: true,
  after: ['session', 'seats'],
  validate(entry, ctx) {
    return readLeads(entry, ctx.check);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['abandon'],
    properties: {
      abandon: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: LEAD_SEATS },
      },
    },
    $comment: 'the seats that may pass --abandon: coordinator, operator or both. Omitted means neither',
  },
};

function readLeads(entry: YamlEntry | undefined, check: Check): Leads {
  if (!entry) return null;
  const node = entry.value;
  const empty = node.kind === 'scalar' && node.value === null;
  if (node.kind !== 'map' && !empty) {
    check.fail(node.line, 'leads must be a map with abandon');
    return null;
  }
  const fields = check.fields(node, 'leads', ['abandon']);
  const abandon = fields.get('abandon');
  if (!abandon) {
    check.fail(node.line, 'leads: abandon is required');
    return null;
  }
  const list = abandon.value;
  const listEmpty = list.kind === 'scalar' && list.value === null;
  if (list.kind !== 'seq' && !listEmpty) {
    check.fail(list.line, 'leads: abandon must be a list of coordinator, operator or both');
    return null;
  }
  // The list is short and ordered: the file says who, and the order is the file's own.
  const items = check.list(abandon, 'leads: abandon');
  const seats: LeadSeat[] = [];
  for (const item of items) {
    if (!(LEAD_SEATS as readonly string[]).includes(item.value) || seats.includes(item.value as LeadSeat)) {
      check.fail(item.line, 'leads: abandon must name coordinator, operator or both');
      continue;
    }
    seats.push(item.value as LeadSeat);
  }
  if (items.length === 0) {
    check.fail(list.line, 'leads: abandon must name coordinator, operator or both');
  }
  return seats.length ? { abandon: seats } : null;
}
