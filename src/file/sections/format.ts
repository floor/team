import type { Section } from './section.ts';

export const format: Section = {
  name: 'format',
  owner: false,
  after: [],
  validate(entry, ctx) {
    if (!entry) ctx.check.fail(1, 'format is required: "format: 1"');
    else if (!(entry.value.kind === 'scalar' && entry.value.value === 1 && !entry.value.quoted)) {
      ctx.check.fail(entry.line, 'format must be 1: this version of team reads no other');
    }
  },
  schema: { const: 1, $comment: 'unquoted: this version of team reads no other' },
};
