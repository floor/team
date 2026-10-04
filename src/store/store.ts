import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprints } from '../approve/fingerprint.ts';

/**
 * The user-level store: what must survive the project folder and stay out of
 * every seat's working folders. One folder per project root, so a project
 * that is moved or renamed is approved again.
 */

export interface Ceilings {
  seats: number;
  temporary: number;
  vendors: Record<string, number>;
}

export interface Approval {
  format: 1;
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

/** The text of the file as the owner last approved it for this root, or null. */
export function approvedCopy(root: string, home: string = homedir()): string | null {
  const store = findStore(root, home);
  if (store === null) return null;
  try {
    return readApproval(store)?.file ?? null;
  } catch {
    return null;
  }
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
}

/** The approval for this project, or null when the owner has approved nothing here. */
export function readApproval(store: string): ApprovalRecord | null {
  const stored = readJson<Approval & { file?: unknown }>(join(store, APPROVAL));
  if (stored === null) return null;
  if (stored.format !== 1) throw new Error(`${join(store, APPROVAL)}: unknown format ${String(stored.format)}`);
  const { file, ...approval } = stored;
  return typeof file === 'string' ? { approval, file } : null;
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
 * Records an approval. The fingerprints that let a file run and the text they
 * are of go in one file, in one atomic write, so a write that stops halfway
 * leaves the earlier approval whole. `approved.yaml` is a copy for the owner
 * to read, and is never read back.
 */
export function writeApproval(store: string, record: ApprovalRecord, seats: readonly LedgerEntry[]): void {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeAtomic(join(store, LEDGER), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`);
  writeAtomic(join(store, APPROVAL), `${JSON.stringify({ ...record.approval, file: record.file }, null, 2)}\n`);
  writeAtomic(join(store, APPROVED_FILE), record.file);
}

/** Adds seats the team has had. The approval itself is left as it is. */
export function recordLedger(store: string, seats: readonly LedgerEntry[]): void {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeAtomic(join(store, LEDGER), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`);
}
