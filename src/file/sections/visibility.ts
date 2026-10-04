import type { TeamFile } from '../types.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';

export const visibility: Section = {
  name: 'visibility',
  owner: true,
  after: ['identity'],
  validate(entry, ctx) {
    const identity = valueOf<TeamFile['identity']>(ctx, 'identity');
    return ctx.check.oneOf(entry, 'visibility', ['public', 'private'])
      ?? (identity.forbiddenPublic.length ? 'public' : 'private');
  },
  schema: { enum: ['public', 'private'] },
};
