// The broker's wire protocol: one JSON line each way, over the clone's one socket. A request
// names the seat and pane the caller claims to be — no token, because a token would have to be
// stored where any sibling seat of the same principal could read it (RFC 008 §5's same-principal
// limit). An answer carries either the read or a refusal, and says which side refused. Both
// parsers are strict and fail closed: a line this build does not know is a refusal, never a
// half-read, so a stale broker process from an older build cannot crash or mislead a seat.
import { join } from 'node:path';
import type { TaskRead, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';

export type BrokerRequest = { op: 'read'; seat: string; pane: string };

/** `at` says which side refused: `caller` is the request-level check (the S2 sentences), `read`
 *  is a read the broker attempted and failed. The seat maps the two to its own exits. */
export type BrokerAnswer =
  | { ok: true; read: TaskRead; notice?: string }
  | { ok: false; at: 'caller' | 'read'; message: string };

/** The socket's home: beside the state and the leases, so a linked worktree shares its main
 *  checkout's one broker exactly as S2 pinned for the lease directory. */
export function brokerSocket(root: string): string {
  return join(root, '.agents', 'broker.sock');
}

/** A request is three short strings; a line past this without its newline is refused. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** One read, bounded by the adapter's own page; an answer past this is refused, never truncated. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export function encodeLine(value: BrokerRequest | BrokerAnswer): string {
  return `${JSON.stringify(value)}\n`;
}

/** The request as this build reads it, or null. Exactly the three keys, op first — a request
 *  with anything extra is not one this build wrote. */
export function parseRequest(line: string): BrokerRequest | null {
  const value = jsonObject(line);
  if (!value) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => key === 'op' || key === 'seat' || key === 'pane')) return null;
  if (value.op !== 'read') return null;
  const seat = name(value.seat);
  const pane = name(value.pane);
  if (seat === null || pane === null) return null;
  return { op: 'read', seat, pane };
}

/** The answer as this build reads it, or null — the fail-safe for a stale broker: an answer this
 *  build does not know is refused by the caller, never half-read. */
export function parseAnswer(line: string): BrokerAnswer | null {
  const value = jsonObject(line);
  if (!value) return null;
  const keys = Object.keys(value);
  if (value.ok === true) {
    if (!keys.every((key) => key === 'ok' || key === 'read' || key === 'notice')) return null;
    const read = parseRead(value.read);
    if (!read) return null;
    if ('notice' in value) {
      if (typeof value.notice !== 'string' || value.notice === '') return null;
      return { ok: true, read, notice: value.notice };
    }
    return { ok: true, read };
  }
  if (value.ok === false) {
    if (!keys.every((key) => key === 'ok' || key === 'at' || key === 'message')) return null;
    if (value.at !== 'caller' && value.at !== 'read') return null;
    if (typeof value.message !== 'string' || value.message === '') return null;
    return { ok: false, at: value.at, message: value.message };
  }
  return null;
}

function jsonObject(line: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function name(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 200) return null;
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) return null;
  return value;
}

/** Every kind of the read union the adapters return; the broker answers `records` unless the
 *  read itself failed, but a stale shape from an older build must still parse or refuse. */
function parseRead(value: unknown): TaskRead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const read = value as Record<string, unknown>;
  if (read.kind === 'missing' || read.kind === 'not-a-list' || read.kind === 'outside') {
    if (Object.keys(read).length !== 1) return null;
    return { kind: read.kind };
  }
  if (read.kind !== 'records') return null;
  if (Object.keys(read).some((key) => key !== 'kind' && key !== 'records' && key !== 'refusals')) return null;
  if (!Array.isArray(read.records) || !Array.isArray(read.refusals)) return null;
  const records: TaskRecord[] = [];
  for (const item of read.records) {
    const record = parseRecord(item);
    if (!record) return null;
    records.push(record);
  }
  const refusals: TaskRefusal[] = [];
  for (const item of read.refusals) {
    const refusal = parseRefusal(item);
    if (!refusal) return null;
    refusals.push(refusal);
  }
  return { kind: 'records', records, refusals };
}

const RECORD_KEYS = ['id', 'title', 'priority', 'assignee', 'milestone', 'deadline', 'blockedBy', 'repos', 'needs', 'description'];

/** A record with exactly the fields of RFC 008's typed shape; `id` and `title` are the record
 *  itself and always cross, so an answer without them is not one this build wrote. */
function parseRecord(value: unknown): TaskRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RECORD_KEYS.includes(key))) return null;
  const id = name(record.id);
  const title = name(record.title);
  if (id === null || title === null) return null;
  const out: TaskRecord = { id, title };
  if ('priority' in record) {
    const priority = record.priority;
    if (typeof priority === 'number' && Number.isFinite(priority)) out.priority = priority;
    else if (typeof priority === 'string' && priority !== '') out.priority = priority;
    else return null;
  }
  for (const key of ['assignee', 'milestone', 'deadline', 'description'] as const) {
    if (!(key in record)) continue;
    const text = record[key];
    if (typeof text !== 'string' || text === '') return null;
    out[key] = text;
  }
  for (const key of ['blockedBy', 'repos', 'needs'] as const) {
    if (!(key in record)) continue;
    const list = record[key];
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item !== '')) return null;
    out[key] = list as string[];
  }
  return out;
}

function parseRefusal(value: unknown): TaskRefusal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const refusal = value as Record<string, unknown>;
  if (Object.keys(refusal).some((key) => key !== 'index' && key !== 'id' && key !== 'reason')) return null;
  if (typeof refusal.index !== 'number' || !Number.isInteger(refusal.index) || refusal.index < 1) return null;
  if (typeof refusal.reason !== 'string' || refusal.reason === '') return null;
  const out: TaskRefusal = { index: refusal.index, reason: refusal.reason };
  if ('id' in refusal) {
    const id = name(refusal.id);
    if (id === null) return null;
    out.id = id;
  }
  return out;
}
