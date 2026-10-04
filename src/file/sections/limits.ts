import type { YamlEntry, YamlNode } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { TeamFile } from '../types.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import type { DraftSeat } from './seats.ts';

type MapNode = Extract<YamlNode, { kind: 'map' }>;

export const limits: Section = {
  name: 'limits',
  owner: true,
  after: ['seats'],
  validate(entry, ctx) {
    const declared = valueOf<DraftSeat[]>(ctx, 'seats').length;
    return readLimits(entry, ctx.check, declared);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      seats: { type: 'integer', minimum: 1 },
      temporary: { type: 'integer', minimum: 0 },
      vendors: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    },
    $comment: 'seats defaults to the declared seats plus temporary',
  },
};

function readLimits(entry: YamlEntry | undefined, check: Check, declared: number): TeamFile['limits'] {
  const fields = check.fields(entry?.value, 'limits', ['seats', 'temporary', 'vendors']);
  const temporary = check.whole(fields.get('temporary'), 'limits.temporary', 0) ?? 2;
  const vendors: Record<string, number> = {};
  const vendorsEntry = fields.get('vendors');
  if (vendorsEntry) {
    const node = vendorsEntry.value as MapNode;
    if (node.kind !== 'map') check.fail(node.line, 'limits.vendors must be a map: a vendor, then its ceiling');
    else {
      for (const vendor of node.entries) {
        const ceiling = check.whole(vendor, `limits.vendors.${vendor.key}`, 0);
        if (ceiling !== undefined) vendors[vendor.key] = ceiling;
      }
    }
  }
  return {
    seats: check.whole(fields.get('seats'), 'limits.seats', 1) ?? declared + temporary,
    temporary,
    vendors,
  };
}
