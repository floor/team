import type { Section, Ctx } from './section.ts';
import { valueOf } from './section.ts';

export const session: Section = {
  name: 'session',
  owner: true,
  after: ['project'],
  validate(entry, ctx) {
    const project = valueOf<string>(ctx, 'project');
    const session = ctx.check.text(entry, 'session') ?? project;
    if (session === 'default') {
      ctx.check.fail(
        ctx.top.get('session')?.line ?? ctx.top.get('project')?.line ?? 1,
        'session can\'t be "default", herdr\'s own session: give the team a session of its own',
      );
    }
    return session;
  },
  // The team's own herdr session, defaulting to the project's name — never `default`, herdr's own.
  schema: { type: 'string', not: { const: 'default' } },
};
