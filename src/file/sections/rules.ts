import type { Section } from './section.ts';

export const rules: Section = {
  name: 'rules',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return ctx.check.list(entry, 'rules').map((item) => item.value);
  },
  schema: { type: 'array', items: { type: 'string', minLength: 1 } },
};
