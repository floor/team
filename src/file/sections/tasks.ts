import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { YamlEntry } from '../../yaml.ts';
import type { TeamFile } from '../types.ts';
import type { Ctx, Section } from './section.ts';

/**
 * The team's one task source. Omitted, it is null and `team issues` refuses rather than
 * inventing a path. Owner-only: a later edit needs a new approval. This slice accepts `file`
 * only — there is no tracker and no broker.
 */
export const tasks: Section = {
  name: 'tasks',
  owner: true,
  after: [],
  validate(entry, ctx) {
    return readTasks(entry, ctx);
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'path'],
    properties: {
      source: { const: 'file' },
      path: { type: 'string', minLength: 1, $comment: 'relative to the checkout, and it must stay inside it' },
      pull: { enum: ['self', 'any'] },
      fallback: { enum: ['file', 'id'] },
    },
    $comment: 'one file adapter. pull is self or any; fallback is file or id. source other than file, and a path that leaves the checkout, are refused',
  },
};

function readTasks(entry: YamlEntry | undefined, ctx: Ctx): TeamFile['tasks'] {
  if (!entry) return null;
  const fields = ctx.check.fields(entry.value, 'tasks', ['source', 'path', 'pull', 'fallback']);
  if (entry.value.kind !== 'map') return null;
  const source = text(fields.get('source'));
  if (source !== 'file') {
    ctx.check.fail(fields.get('source')?.value.line ?? entry.value.line, 'tasks.source must be file');
  }
  const path = text(fields.get('path'));
  if (!path || !taskPathStaysInside(path, ctx.rootDir)) {
    ctx.check.fail(fields.get('path')?.value.line ?? entry.value.line, 'tasks.path must stay inside the checkout');
  }
  const pull = choice(fields.get('pull'), ['self', 'any'] as const, 'tasks.pull must be self or any', ctx);
  const fallback = choice(fields.get('fallback'), ['file', 'id'] as const, 'tasks.fallback must be file or id', ctx);
  if (source !== 'file' || !path || !taskPathStaysInside(path, ctx.rootDir)) return null;
  if (fields.get('pull') && pull === undefined) return null;
  if (fields.get('fallback') && fallback === undefined) return null;
  const tasks: NonNullable<TeamFile['tasks']> = { source: 'file', path };
  if (pull) tasks.pull = pull;
  if (fallback) tasks.fallback = fallback;
  return tasks;
}

/** An omitted key stays omitted. A present key must be one of `allowed`. */
function choice<T extends string>(entry: YamlEntry | undefined, allowed: readonly T[], message: string, ctx: Ctx): T | undefined {
  if (!entry) return undefined;
  const value = text(entry);
  if (value !== undefined && (allowed as readonly string[]).includes(value)) return value as T;
  ctx.check.fail(entry.value.line, message);
  return undefined;
}

function text(entry: YamlEntry | undefined): string | undefined {
  if (!entry || entry.value.kind !== 'scalar' || typeof entry.value.value !== 'string' || entry.value.value === '') return undefined;
  return entry.value.value;
}

/**
 * A task path is relative to the checkout and lexical `..` cannot leave it. When the root is
 * known, a symlink that resolves outside is the same refusal. A name that only starts with `..`
 * is inside.
 */
export function taskPathStaysInside(path: string, root?: string): boolean {
  if (path.startsWith('~') || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return false;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return false;
  if (!root) return true;
  const abs = resolve(root, segments.join('/'));
  const rel = relative(root, abs);
  if (relativeEscapes(rel)) return false;
  return !symlinkLeaves(abs, root);
}

/** The relative result leaves the checkout when it is `..`, starts with `../`, or is absolute. */
export function relativeEscapes(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

function symlinkLeaves(target: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  let cursor = target;
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        const fromRoot = relative(realRoot, realpathSync(cursor));
        if (relativeEscapes(fromRoot)) return true;
      }
    } catch {
      // Absent. The parent that exists is checked on the next step.
    }
    if (cursor === root) return false;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}
