import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprints } from '../approve/fingerprint.ts';
import { bumpGeneration, keyOf, loadKey, recordedGeneration, signPayload, verifyPayload, type Json } from './keys.ts';

/**
 * The user-level store: what must survive the project folder and stay out of
 * every seat's working folders. One folder per project root, so a project
 * that is moved or renamed is approved again.
 *
 * A record is signed (format 2): the approval, the stored copy of the file, the
 * project root and a per-project generation, in one canonical encoding. Every
 * reader goes through `approvalStanding`, which verifies the whole record once
 * and hands back an immutable snapshot; a record that does not verify is not an
 * approval, and the standing says which case it is. The key and the generations
 * live outside the store, in a folder of their own (see keys.ts).
 */

export interface Ceilings {
  seats: number;
  temporary: number;
  vendors: Record<string, number>;
}

export interface Approval {
  format: 1 | 2;
  approvedAt: string;
  /** The project root the approval is for. */
  root: string;
  fingerprints: Fingerprints;
  /** Fixed here, and never recomputed from the roster. */
  ceilings: Ceilings;
  /** Each account's check command, resolved and hashed. Absent on an older record. */
  checks?: Record<string, { command: string; path: string; hash: string }>;
  /**
   * The override file as approved, or null when the owner approved there being
   * none. Absent on a record written before the file existed.
   */
  overrides?: string | null;
}

export interface LedgerEntry {
  display: string;
  role: string;
  model: string;
  version: string;
}

const APPROVAL = 'approval.json';
const APPROVED_FILE = 'approved.yaml';
const LEDGER = 'ledger.json';

function rootHash(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that doesn't exist yet keeps its path as given.
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 12);
}

function storesFolder(home: string): string {
  return join(home, '.config', 'team');
}

/** The store's folder for a project: `<home>/.config/team/<project>-<hash of the root's path>`. */
export function storePath(project: string, root: string, home: string = homedir()): string {
  const name = project.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(storesFolder(home), `${name}-${rootHash(root)}`);
}

/**
 * The store of the project at this root, found without its file: the folder
 * whose name ends with the root's hash. Null when the owner approved nothing
 * for this root on this machine.
 */
export function findStore(root: string, home: string = homedir()): string | null {
  const suffix = `-${rootHash(root)}`;
  let names: string[];
  try {
    names = readdirSync(storesFolder(home));
  } catch {
    return null;
  }
  const name = names.sort().find((candidate) => candidate.endsWith(suffix));
  return name === undefined ? null : join(storesFolder(home), name);
}

/** The repair every refused record names, and the one a legacy record names. */
export const LEGACY_LINE = 'approved before records were signed: run `team approve` once';

/**
 * What the approval store says about a root, verified. The one snapshot every
 * reader uses: `verified` carries a record no caller can change, `legacy` is a
 * record written before records were signed (not trusted, still displayed), and
 * `refused` says which case — each with the one-step repair. `none` is an
 * approval store with nothing in it for this root.
 */
export type Standing =
  | { kind: 'none' }
  | { kind: 'legacy' }
  | { kind: 'refused'; why: string }
  | { kind: 'verified'; record: ApprovalRecord; generation: number; signedAt: string };

function sameRoot(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(a) === real(b);
}

/** The bytes a signature covers: the approval, the stored copy, the root inside it, the generation. */
function payloadOf(approval: Approval, file: string, generation: number): Json {
  return {
    format: 2,
    approval: {
      approvedAt: approval.approvedAt,
      root: approval.root,
      fingerprints: { sections: approval.fingerprints.sections, seats: approval.fingerprints.seats },
      ceilings: { seats: approval.ceilings.seats, temporary: approval.ceilings.temporary, vendors: approval.ceilings.vendors },
      checks: approval.checks ?? null,
      overrides: approval.overrides ?? null,
    },
    file,
    generation,
  };
}

/**
 * The standing of this root's approval, from one verified read. A reader never
 * parses the store itself: this is the only way in, and it returns the record
 * only when the whole of it — approval, stored copy, root and generation —
 * carries a signature of this machine's key.
 */
export function approvalStanding(root: string, home: string = homedir()): Standing {
  const store = findStore(root, home);
  if (store === null) return { kind: 'none' };
  let record: ApprovalRecord | null;
  try {
    record = readApproval(store);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    return { kind: 'refused', why: `the approval record cannot be read${detail}: run \`team approve\` once` };
  }
  if (record === null) return { kind: 'none' };
  if (record.approval.format === 1) return { kind: 'legacy' };
  const { generation, signature } = record;
  if (typeof signature !== 'string' || generation === undefined || !Number.isInteger(generation) || generation < 1) {
    return { kind: 'refused', why: 'the record is not in the signed form this version writes: run `team approve` once' };
  }
  const key = loadKey(home);
  if (key === null) {
    return { kind: 'refused', why: 'the record is signed, but its key is missing: run `team approve` once to approve again' };
  }
  if (!verifyPayload(payloadOf(record.approval, record.file, generation), signature, key)) {
    return { kind: 'refused', why: 'the record does not carry a valid signature: it was changed after approval, or written without the key: run `team approve` once' };
  }
  if (!sameRoot(record.approval.root, root)) {
    return { kind: 'refused', why: `the record approves another project root (${record.approval.root}): run \`team approve\` once` };
  }
  const recorded = recordedGeneration(root, home);
  if (recorded === null) {
    return { kind: 'refused', why: 'no generation is recorded for this project: run `team approve` once' };
  }
  if (generation !== recorded.generation) {
    return generation < recorded.generation
      ? { kind: 'refused', why: `the record is approval #${generation} but #${recorded.generation} is recorded: an approval was interrupted or an older record was replayed: run \`team approve\` once` }
      : { kind: 'refused', why: `the record is approval #${generation} but only #${recorded.generation} is recorded: the key folder was rolled back: run \`team approve\` once` };
  }
  return { kind: 'verified', record: frozen(record), generation, signedAt: recorded.at };
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

/** The text of the file as the owner last approved it for this root, or null: this copy is verified. */
export function approvedCopy(root: string, home: string = homedir()): string | null {
  const standing = approvalStanding(root, home);
  return standing.kind === 'verified' ? standing.record.file : null;
}

function readJson<T>(path: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as T;
}

/** Writes to a temporary file, then renames it: a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

export interface ApprovalRecord {
  approval: Approval;
  /** The text of the file as it was approved. */
  file: string;
  /** The signing's number for this project. On a signed record only. */
  generation?: number;
  /** The signature over the canonical payload. On a signed record only. */
  signature?: string;
}

/**
 * The approval for this project as the store holds it, parsed without judging
 * it: legacy records read here too, so `approve` can diff against what is on
 * disk. Trusting it is `approvalStanding`'s to decide, never a caller's.
 */
export function readApproval(store: string): ApprovalRecord | null {
  const stored = readJson<Approval & { file?: unknown; generation?: unknown; signature?: unknown }>(join(store, APPROVAL));
  if (stored === null) return null;
  if (stored.format !== 1 && stored.format !== 2) throw new Error(`${join(store, APPROVAL)}: unknown format ${String(stored.format)}`);
  const { file, generation, signature, ...approval } = stored;
  if (typeof file !== 'string') return null;
  return {
    approval,
    file,
    ...(typeof generation === 'number' ? { generation } : {}),
    ...(typeof signature === 'string' ? { signature } : {}),
  };
}

/** The ledger: every `display` and `role` the team has had. */
export function readLedger(store: string): LedgerEntry[] {
  return readJson<LedgerEntry[]>(join(store, LEDGER)) ?? [];
}

function sameEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  return a.display === b.display && a.role === b.role && a.model === b.model && a.version === b.version;
}

/** The ledger with these seats added; entries are never removed. */
export function mergeLedger(ledger: readonly LedgerEntry[], seats: readonly LedgerEntry[]): LedgerEntry[] {
  const merged = [...ledger];
  for (const seat of seats) {
    const entry = { display: seat.display, role: seat.role, model: seat.model, version: seat.version };
    if (!merged.some((known) => sameEntry(known, entry))) merged.push(entry);
  }
  return merged;
}

/**
 * Records an approval, signed. The generation of this project moves first —
 * atomically, in the key folder — then the whole record (approval, stored copy,
 * root and generation) is signed with the owner's key and written in one atomic
 * write, so a write that stops halfway leaves the earlier approval stale, which
 * every reader refuses with the repair rather than trusting half a record.
 * `approved.yaml` stays a copy for the owner to read, never read back. Every
 * signing moves the generation: an amendment by `add` or `remove --keep` is a
 * signing too, and shows up as one.
 */
export function writeApproval(
  store: string,
  record: ApprovalRecord,
  seats: readonly LedgerEntry[],
  home: string = homedir(),
  now: Date = new Date(),
): number {
  const key = keyOf(home);
  const generation = bumpGeneration(record.approval.root, home, now);
  const signature = signPayload(payloadOf(record.approval, record.file, generation), key);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeAtomic(join(store, LEDGER), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`);
  writeAtomic(join(store, APPROVAL), `${JSON.stringify({ ...record.approval, file: record.file, generation, signature }, null, 2)}\n`);
  writeAtomic(join(store, APPROVED_FILE), record.file);
  return generation;
}

/** Adds seats the team has had. The approval itself is left as it is. */
export function recordLedger(store: string, seats: readonly LedgerEntry[]): void {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeAtomic(join(store, LEDGER), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`);
}
