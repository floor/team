import type { Section } from './section.ts';

export type Dialogs = { trust: 'owner' | 'coordinator' };

/** Omitted means the owner answers every trust dialog. The only key is `trust`. */
export const dialogs: Section = {
  name: 'dialogs',
  owner: true,
  after: [],
  validate(entry, ctx) {
    if (!entry) return { trust: 'owner' } satisfies Dialogs;
    if (entry.value.kind !== 'map') {
      ctx.check.fail(entry.line, 'dialogs must be a map containing trust');
      return { trust: 'owner' } satisfies Dialogs;
    }
    const fields = ctx.check.fields(entry.value, 'dialogs', ['trust']);
    if (entry.value.entries.length === 0 || !fields.has('trust')) {
      ctx.check.fail(entry.line, 'dialogs must contain trust');
    }
    const trust = ctx.check.oneOf(fields.get('trust'), 'dialogs.trust', ['owner', 'coordinator']);
    return { trust: trust ?? 'owner' } satisfies Dialogs;
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['trust'],
    properties: { trust: { enum: ['owner', 'coordinator'] } },
    $comment: 'who may answer a folder-trust dialog. Omitted means owner, and then no command sends a trust key',
  },
};
