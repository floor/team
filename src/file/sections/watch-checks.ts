import type { Section } from './section.ts';

/**
 * Not a top-level key: the line inside `watch` that turns a check off. It stands in the list
 * because the owner-only sections are generated from it, and its digest is its own — turning a
 * check off reads as `watch.checks` changed, never as a threshold change too. The checks
 * themselves are read by `watch`, so this section validates nothing: it is a name in the list,
 * and a fragment that lives inside the watch one.
 */
export const watchChecks: Section = {
  name: 'watch.checks',
  owner: true,
  after: [],
  validate: () => undefined,
  schema: { $comment: 'inside watch: the checks property of the watch fragment' },
};
