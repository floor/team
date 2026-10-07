import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import { readLeadField } from './lead.ts';
import type { DraftSeat } from './seats.ts';

export const coordinator: Section = {
  name: 'coordinator',
  owner: true,
  after: ['seats'],
  validate(entry, ctx) {
    // The key is still read, and the file may put `leads: true` on the lead's seat instead. The
    // notice says so once, at the key's line, whether or not the mark stands beside it.
    if (entry) {
      ctx.check.warnings.push({ line: entry.value.line, message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read' });
    }
    return readLeadField(entry, ctx.leads, valueOf<DraftSeat[]>(ctx, 'seats'), ctx.broken, ctx.check);
  },
  schema: {
    type: 'string',
    minLength: 1,
    deprecated: true,
    $comment: 'one seat may carry `leads: true` instead; a key must name a declared seat: one, without count, neither parked nor stopped',
  },
};
