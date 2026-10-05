import type { YamlEntry, YamlNode } from '../../yaml.ts';
import type { Check, Fields } from '../check.ts';

/** What a section reads and writes while the file is validated. */
export interface Ctx {
  /** Every problem and warning, and the field helpers that report them. */
  check: Check;
  /** The whole file, for errors that belong to the file itself rather than one section. */
  root: YamlNode;
  /** The file's own fields, by top-level key. */
  top: Fields;
  /** The names of seats left out for their own problems, shared with the sections that name seats. */
  broken: Set<string>;
  /** Each section's value, set once the section has run. */
  values: Map<string, unknown>;
  /** Injected home for path validation. */
  home?: string;
}

/** A section's value, once every section it names in `after` has run. */
export function valueOf<T>(ctx: Ctx, name: string): T {
  const value = ctx.values.get(name);
  if (value === undefined) throw new Error(`section "${name}" has not run before its reader; name it in "after"`);
  return value as T;
}

/** A JSON Schema fragment for one section, assembled into the file's schema by the generator. */
export type JsonSchema = Record<string, unknown>;

/** One top-level section of the team file, read and checked on its own. */
export interface Section {
  /** The top-level key; `watch.checks` names a line inside `watch`, not a key of its own. */
  name: string;
  /** True when only the owner changes it: `team approve` fingerprints exactly these, in list order. */
  owner: boolean;
  /** The sections whose value this one reads; the validator runs it once those have run. */
  after: readonly string[];
  /** The code from `validate.ts`, moved as it was: reads its entry, reports, returns its value. */
  validate(entry: YamlEntry | undefined, ctx: Ctx): unknown;
  /** The JSON Schema fragment for this section. */
  schema: JsonSchema;
}
