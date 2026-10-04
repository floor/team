import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import type { TeamFile } from '../types.ts';
import type { Section } from './section.ts';

export const tools: Section = {
  name: 'tools',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return readTools(entry, ctx.check);
  },
  schema: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      properties: { kind: { type: 'string', minLength: 1 } },
      required: ['kind'],
      additionalProperties: { type: 'string' },
    },
    $comment: 'a tool is a name, then its kind and where it is; every field but the kind is text',
  },
};

function readTools(entry: YamlEntry | undefined, check: Check): TeamFile['tools'] {
  const tools: TeamFile['tools'] = {};
  if (!entry) return tools;
  if (entry.value.kind !== 'map') {
    check.fail(entry.value.line, 'tools must be a map: a name, then its kind and where it is');
    return tools;
  }
  for (const tool of entry.value.entries) {
    const fields: Record<string, string> = {};
    if (tool.value.kind !== 'map') {
      check.fail(tool.value.line, `tools.${tool.key} must be a map with a kind`);
      continue;
    }
    for (const field of tool.value.entries) {
      const value = check.text(field, `tools.${tool.key}.${field.key}`);
      if (value !== undefined) fields[field.key] = value;
    }
    if (!('kind' in fields)) check.fail(tool.line, `tools.${tool.key} needs a kind`);
    tools[tool.key] = fields;
  }
  return tools;
}
