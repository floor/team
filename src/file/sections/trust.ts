import { trustProblem } from '../paths.ts';
import type { Section } from './section.ts';

export const trust: Section = {
  name: 'trust',
  owner: true,
  after: [],
  validate(entry, ctx) {
    const trustItems = ctx.check.list(entry, 'trust');
    for (const item of trustItems) {
      const problem = trustProblem(item.value);
      if (problem) ctx.check.fail(item.line, `trust: "${item.value}" ${problem}`);
    }
    return trustItems.map((item) => item.value);
  },
  schema: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    $comment: 'paths outside the project the seats may still work in, as the validator reads them',
  },
};
