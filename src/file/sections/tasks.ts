import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { TASK_FIELDS, type TaskField, type TaskPolicy } from '../../broker/policy.ts';
import type { YamlEntry } from '../../yaml.ts';
import type { TeamFile } from '../types.ts';
import type { Ctx, Section } from './section.ts';

/**
 * The team's one task source. Omitted, it is null and `team issues` refuses rather than
 * inventing a path. Owner-only: a later edit needs a new approval. Two sources: `file`, the
 * list the owner committed, whose records are already in the seats' own checkout; and `linear`,
 * read by the broker with the owner's Keychain credential — never by a seat. The `linear`
 * block is refused for a file source, and the `policy` — which fields cross the broker's
 * boundary — is refused for a file source too: a policy that governs nothing must not read as
 * if it governed something. An omitted key is absent on the parsed value, so an approval of an
 * older `tasks:` section still matches.
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
    required: ['source'],
    if: { required: ['source'], properties: { source: { const: 'linear' } } },
    then: { required: ['linear'] },
    else: { required: ['path'] },
    properties: {
      source: { enum: ['file', 'linear'] },
      path: { type: 'string', minLength: 1, $comment: 'for source: file, relative to the checkout, and it must stay inside it' },
      linear: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'keychainService'],
        properties: {
          project: { type: 'string', minLength: 1, $comment: 'the tracker project the read is bounded to' },
          keychainService: { type: 'string', minLength: 1, $comment: 'the macOS Keychain service naming the key; read by the broker only' },
        },
        $comment: 'the tracker the broker reads; required for source: linear, refused for source: file',
      },
      pull: { enum: ['self', 'any'] },
      fallback: { enum: ['file', 'id'] },
      policy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow: { type: 'array', items: { enum: [...TASK_FIELDS] } },
          omit: { type: 'array', items: { enum: [...TASK_FIELDS] } },
          transform: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { const: 'bare' } },
            $comment: 'one transform is defined in this build: id: bare',
          },
        },
        $comment:
          'which record fields cross the broker boundary: allow names the set, omit removes from the default; the two are not used together, and id and title are the record itself — allow must name both, omit must name neither. refused for source: file',
      },
    },
    $comment:
      'one task source. source file needs path; source linear needs the linear block. pull is self or any; fallback is file or id. a path that leaves the checkout, a linear block or policy with source file, and a policy that omits id or title are refused',
  },
};

function readTasks(entry: YamlEntry | undefined, ctx: Ctx): TeamFile['tasks'] {
  if (!entry) return null;
  const fields = ctx.check.fields(entry.value, 'tasks', ['source', 'path', 'linear', 'pull', 'fallback', 'policy']);
  if (entry.value.kind !== 'map') return null;
  const pull = choice(fields.get('pull'), ['self', 'any'] as const, 'tasks.pull must be self or any', ctx);
  const fallback = choice(fields.get('fallback'), ['file', 'id'] as const, 'tasks.fallback must be file or id', ctx);
  const badChoice = (fields.get('pull') && pull === undefined) || (fields.get('fallback') && fallback === undefined);
  const source = text(fields.get('source'));
  if (source === 'file') {
    if (fields.get('linear')) ctx.check.fail(fields.get('linear')!.value.line, 'tasks.linear is for source: linear');
    if (fields.get('policy')) {
      ctx.check.fail(fields.get('policy')!.value.line, 'tasks.policy is for a broker source; source: file has no broker');
    }
    const path = text(fields.get('path'));
    if (!path || !taskPathStaysInside(path, ctx.rootDir)) {
      ctx.check.fail(fields.get('path')?.value.line ?? entry.value.line, 'tasks.path must stay inside the checkout');
    }
    if (badChoice || fields.get('linear') || fields.get('policy') || !path || !taskPathStaysInside(path, ctx.rootDir)) return null;
    const tasks: Extract<NonNullable<TeamFile['tasks']>, { source: 'file' }> = { source: 'file', path };
    if (pull) tasks.pull = pull;
    if (fallback) tasks.fallback = fallback;
    return tasks;
  }
  if (source === 'linear') {
    if (fields.get('path')) ctx.check.fail(fields.get('path')!.value.line, 'tasks.path is for source: file');
    const linear = readLinear(fields.get('linear'), entry, ctx);
    const policy = readPolicy(fields.get('policy'), ctx);
    if (badChoice || fields.get('path') || !linear || (fields.get('policy') && !policy)) return null;
    const tasks: Extract<NonNullable<TeamFile['tasks']>, { source: 'linear' }> = { source: 'linear', linear };
    if (pull) tasks.pull = pull;
    if (fallback) tasks.fallback = fallback;
    if (policy) tasks.policy = policy;
    return tasks;
  }
  ctx.check.fail(fields.get('source')?.value.line ?? entry.value.line, 'tasks.source must be file or linear');
  return null;
}

/**
 * The one linear sibling, with the shape the key is read from: the project the read is bounded
 * to, and the Keychain service `keychainReader` is asked for. The key itself lives in the
 * owner's Keychain and in the broker's memory; it is never written into this file.
 */
function readLinear(
  entry: YamlEntry | undefined,
  parent: YamlEntry,
  ctx: Ctx,
): { project: string; keychainService: string } | undefined {
  const fields = ctx.check.fields(entry?.value, 'tasks.linear', ['project', 'keychainService']);
  const line = entry?.value.line ?? parent.value.line;
  const project = ctx.check.required(fields.get('project'), 'tasks.linear.project', line);
  const keychainService = ctx.check.required(fields.get('keychainService'), 'tasks.linear.keychainService', line);
  if (!project || !keychainService) return undefined;
  return { project, keychainService };
}

/**
 * The per-field policy of a broker source, as written: omitted keys stay absent, so an older
 * approval still matches. `allow` names the set of fields that cross, `omit` removes from the
 * default set; naming both is refused. `id` and `title` are the record itself — an `allow` that
 * does not name both, and an `omit` that names either, are refused — and the broker keeps them
 * regardless.
 */
function readPolicy(entry: YamlEntry | undefined, ctx: Ctx): TaskPolicy | undefined {
  if (!entry) return undefined;
  const fields = ctx.check.fields(entry.value, 'tasks.policy', ['allow', 'omit', 'transform']);
  if (entry.value.kind !== 'map') return undefined;
  const allowEntry = fields.get('allow');
  const omitEntry = fields.get('omit');
  const together = allowEntry !== undefined && omitEntry !== undefined;
  if (together) ctx.check.fail(entry.value.line, 'tasks.policy: allow and omit are not used together');
  const allow = fieldList(allowEntry, 'tasks.policy.allow', ctx);
  const omit = fieldList(omitEntry, 'tasks.policy.omit', ctx);
  if (allow && !(allow.includes('id') && allow.includes('title'))) {
    ctx.check.fail(allowEntry?.value.line ?? entry.value.line, 'tasks.policy.allow must name id and title, the record itself');
  }
  if (omit && (omit.includes('id') || omit.includes('title'))) {
    ctx.check.fail(omitEntry?.value.line ?? entry.value.line, 'tasks.policy.omit must not name id or title, the record itself');
  }
  const transform = readTransform(fields.get('transform'), ctx);
  if (together) return undefined;
  const policy: TaskPolicy = {};
  if (allow) policy.allow = allow;
  if (omit) policy.omit = omit;
  if (transform) policy.transform = transform;
  return policy;
}

/** A policy list: every item a task-field name, in the file's own spelling. A non-list, a
 *  non-text item, and a name that is not a task field each refuse with their own sentence. */
function fieldList(entry: YamlEntry | undefined, name: string, ctx: Ctx): TaskField[] | undefined {
  if (!entry) return undefined;
  const node = entry.value;
  if (node.kind !== 'seq') {
    ctx.check.fail(node.line, `${name} must be a list of task fields`);
    return undefined;
  }
  const out: TaskField[] = [];
  let bad = false;
  for (const item of node.items) {
    if (item.kind === 'scalar' && typeof item.value === 'string' && item.value !== '') {
      if ((TASK_FIELDS as readonly string[]).includes(item.value)) {
        out.push(item.value as TaskField);
      } else {
        ctx.check.fail(item.line, `${name} lists "${item.value}", not a task field`);
        bad = true;
      }
    } else {
      ctx.check.fail(item.line, `${name} must be a list of task fields`);
      bad = true;
    }
  }
  return bad ? undefined : out;
}

/** One transform is defined in this build — `id: bare` — and the map is a closed set: any other
 *  key, any other value, and an empty map all refuse with the one sentence. */
function readTransform(entry: YamlEntry | undefined, ctx: Ctx): { id: 'bare' } | undefined {
  if (!entry) return undefined;
  const sentence = 'tasks.policy.transform: only id: bare is defined in this build';
  const node = entry.value;
  if (node.kind !== 'map' || node.entries.length === 0) {
    ctx.check.fail(node.line, sentence);
    return undefined;
  }
  let ok = false;
  for (const field of node.entries) {
    if (field.key !== 'id') {
      ctx.check.fail(field.line, sentence);
      continue;
    }
    if (field.value.kind === 'scalar' && field.value.value === 'bare') {
      ok = true;
    } else {
      ctx.check.fail(field.value.line, sentence);
    }
  }
  return ok ? { id: 'bare' } : undefined;
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
