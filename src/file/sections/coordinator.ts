import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import { readLead } from './lead.ts';
import type { DraftSeat } from './seats.ts';

export const coordinator: Section = {
  name: 'coordinator',
  owner: true,
  after: ['seats'],
  validate(entry, ctx) {
    return readLead(entry, 'coordinator', valueOf<DraftSeat[]>(ctx, 'seats'), ctx.broken, ctx.check);
  },
  schema: { type: 'string', minLength: 1, $comment: 'must name a declared seat: one, without count, neither parked nor stopped' },
};
