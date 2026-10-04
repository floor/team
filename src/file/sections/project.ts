import type { Section } from './section.ts';

export const project: Section = {
  name: 'project',
  owner: false,
  after: [],
  validate(entry, ctx) {
    const project = ctx.check.required(entry, 'project', 1) ?? '';
    if (project && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) {
      ctx.check.fail(entry?.line ?? 1, 'project must be a short name: letters, digits, ".", "_" and "-"');
    }
    return project;
  },
  schema: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
};
