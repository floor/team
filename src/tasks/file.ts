// The file adapter. It reads a YAML list the owner committed. It does not write, and it holds
// no credential. The command calls it only through the adapter interface.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { relativeEscapes, taskPathStaysInside } from '../file/sections/tasks.ts';
import { parseYaml, YamlError, type YamlNode } from '../yaml.ts';
import type { TaskAdapter, TaskRead, TaskReadInput, TaskRecord, TaskRefusal } from './adapter.ts';

/** The message id rule (`src/commands/messages.ts`). A task id is the same token. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const KNOWN = ['id', 'title', 'priority', 'assignee', 'milestone', 'deadline', 'blocked-by', 'repos', 'needs', 'description'];

export const fileAdapter: TaskAdapter = { name: 'file', read: readTaskFile };

/** The only registry entry this slice ships. */
export const fileRegistry: Record<string, TaskAdapter> = { file: fileAdapter };

function readTaskFile(input: TaskReadInput): TaskRead {
  if (!taskPathStaysInside(input.path, input.root)) return { kind: 'outside' };
  const full = resolve(input.root, input.path);
  if (!isFileInside(full, input.root)) return { kind: 'missing' };
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  // The team-file parser accepts a flow sequence on one line, and a block sequence as a
  // document. A document that is only `[]` is the empty list: the block form has no empty spelling.
  if (text.trim() === '[]') return { kind: 'records', records: [], refusals: [] };
  let node: YamlNode;
  try {
    node = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { kind: 'not-a-list' };
    throw error;
  }
  if (node.kind !== 'seq') return { kind: 'not-a-list' };
  const records: TaskRecord[] = [];
  const refusals: TaskRefusal[] = [];
  node.items.forEach((item, index) => {
    const read = readRecord(item, index + 1);
    if ('reason' in read) refusals.push(read);
    else records.push(read);
  });
  return { kind: 'records', records, refusals };
}

function isFileInside(full: string, root: string): boolean {
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    const realRoot = realpathSync(root);
    const real = realpathSync(full);
    const fromRoot = relative(realRoot, real);
    if (relativeEscapes(fromRoot)) return false;
    return lstatSync(real).isFile();
  } catch {
    return false;
  }
}

function readRecord(node: YamlNode, index: number): TaskRecord | TaskRefusal {
  if (node.kind !== 'map') return { index, reason: 'id is required' };
  const entries = new Map(node.entries.map((entry) => [entry.key, entry.value]));
  const idNode = entries.get('id');
  if (!idNode) return { index, reason: 'id is required' };
  const id = line(idNode);
  if (id === undefined || !ID.test(id)) return { index, reason: 'its id is not a task id' };
  const titleNode = entries.get('title');
  if (!titleNode) return { index, id, reason: 'title is required' };
  const title = line(titleNode);
  if (title === undefined || title.length < 1 || title.length > 200) return { index, id, reason: 'title must be a single line' };
  const priority = optionalPriority(entries.get('priority'));
  if (priority === 'bad') return { index, id, reason: 'priority is not text or a number' };
  const assignee = optionalText(entries.get('assignee'));
  if (assignee === 'bad') return { index, id, reason: 'assignee must be text' };
  const milestone = optionalText(entries.get('milestone'));
  if (milestone === 'bad') return { index, id, reason: 'milestone must be text' };
  const deadline = optionalText(entries.get('deadline'));
  if (deadline === 'bad') return { index, id, reason: 'deadline must be text' };
  const blockedBy = optionalIds(entries.get('blocked-by'));
  if (blockedBy === 'bad') return { index, id, reason: 'blocked-by is not a list of task ids' };
  const repos = optionalNames(entries.get('repos'));
  if (repos === 'bad') return { index, id, reason: 'repos is not a list of names' };
  const needs = optionalNames(entries.get('needs'));
  if (needs === 'bad') return { index, id, reason: 'needs is not a list of names' };
  const description = optionalDescription(entries.get('description'));
  if (description === 'bad') return { index, id, reason: 'description must be text' };
  if (description === 'long') return { index, id, reason: 'description is over 4000 characters' };
  for (const entry of node.entries) {
    if (!KNOWN.includes(entry.key)) return { index, id, reason: `unknown field "${entry.key}"` };
  }
  const record: TaskRecord = { id, title };
  if (priority !== undefined) record.priority = priority;
  if (assignee !== undefined) record.assignee = assignee;
  if (milestone !== undefined) record.milestone = milestone;
  if (deadline !== undefined) record.deadline = deadline;
  if (blockedBy !== undefined) record.blockedBy = blockedBy;
  if (repos !== undefined) record.repos = repos;
  if (needs !== undefined) record.needs = needs;
  if (description !== undefined) record.description = description;
  return record;
}

function line(node: YamlNode): string | undefined {
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value.includes('\n') || node.value.includes('\r')) return undefined;
  return node.value;
}

function optionalText(node: YamlNode | undefined): string | undefined | 'bad' {
  if (!node) return undefined;
  const value = line(node);
  if (value === undefined || value === '') return 'bad';
  return value;
}

function optionalPriority(node: YamlNode | undefined): string | number | undefined | 'bad' {
  if (!node) return undefined;
  if (node.kind !== 'scalar') return 'bad';
  if (typeof node.value === 'number' && Number.isFinite(node.value)) return node.value;
  if (typeof node.value === 'string' && node.value !== '' && !node.value.includes('\n') && !node.value.includes('\r')) return node.value;
  return 'bad';
}

function optionalDescription(node: YamlNode | undefined): string | undefined | 'bad' | 'long' {
  if (!node) return undefined;
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') return 'bad';
  if (node.value.length > 4000) return 'long';
  return node.value;
}

function optionalIds(node: YamlNode | undefined): string[] | undefined | 'bad' {
  if (!node) return undefined;
  if (node.kind !== 'seq') return 'bad';
  const ids: string[] = [];
  for (const item of node.items) {
    const value = line(item);
    if (value === undefined || !ID.test(value)) return 'bad';
    ids.push(value);
  }
  return ids;
}

function optionalNames(node: YamlNode | undefined): string[] | undefined | 'bad' {
  if (!node) return undefined;
  if (node.kind !== 'seq') return 'bad';
  const names: string[] = [];
  for (const item of node.items) {
    const value = line(item);
    if (value === undefined || value === '') return 'bad';
    names.push(value);
  }
  return names;
}
