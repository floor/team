import type { JsonSchema } from './section.ts';

export const DURATION = { s: 1, m: 60, h: 3600 };
export const PERCENT = { '%': 1 };
export const SIZE = { MB: 1e6, GB: 1e9, TB: 1e12 };

/** The schema of a measure, its unit tables deciding the pattern the text must fit. */
export function measureSchema(units: Record<string, number>): JsonSchema {
  const unit = Object.keys(units).join('|');
  return { type: 'string', pattern: `^[0-9]+(?:\\.[0-9]+)?(${unit})$` };
}
