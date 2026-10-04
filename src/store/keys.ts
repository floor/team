// The signing key and the per-project generations, kept outside every store a
// seat's rules mention, in a folder of their own. A seat runs as the owner's
// user, so it can read this key as easily as the owner can: the signature is
// evidence of who wrote a record, not a wall against the process that runs it.
// What it buys is narrower and real: a record rewritten without the key is
// refused, and each signing the owner never made shows up as a generation they
// never saw. No key store of the system is touched — no Keychain, no prompt —
// only these files, under the home `team` was given.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_FORMAT = 1;

/** The ceiling of a counter that must stay exactly what it claims: an integer. */
export const SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

function rootHash(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that doesn't exist yet keeps its path as given.
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 12);
}

/** `<home>/.config/team-key`, beside the stores but never inside one. */
export function keyFolder(home: string = homedir()): string {
  return join(home, '.config', 'team-key');
}

function keyPath(home: string): string {
  return join(keyFolder(home), 'key.json');
}

function generationPath(root: string, home: string): string {
  return join(generationsFolder(home), `${rootHash(root)}.json`);
}

/** `<home>/.config/team-key/generations`, one file per project root. */
export function generationsFolder(home: string): string {
  return join(keyFolder(home), 'generations');
}

type StoredKey = { format: number; algorithm: string; private: string };

/**
 * The owner's signing key, an Ed25519 pair. Only the private half is kept —
 * the public one is derived from it — as PKCS8 PEM inside `key.json` (mode 600,
 * the folder 700). Created at the first `approve`; never by a reader.
 */
export function loadKey(home: string): KeyObject | null {
  let text: string;
  try {
    text = readFileSync(keyPath(home), 'utf8');
  } catch {
    return null;
  }
  try {
    const stored = JSON.parse(text) as StoredKey;
    if (stored.format !== KEY_FORMAT || stored.algorithm !== 'ed25519' || typeof stored.private !== 'string') return null;
    return createPrivateKey(stored.private);
  } catch {
    return null;
  }
}

/** A new key in its own folder, or the one already there. */
export function keyOf(home: string): KeyObject {
  const existing = loadKey(home);
  if (existing !== null) return existing;
  // Each folder is made on its own line: a recursive mkdir applies its mode to
  // the last folder only, and both of these are the owner's alone.
  mkdirSync(keyFolder(home), { recursive: true, mode: 0o700 });
  mkdirSync(generationsFolder(home), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  const stored: StoredKey = {
    format: KEY_FORMAT,
    algorithm: 'ed25519',
    private: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  writeFileSync(keyPath(home), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  return createPrivateKey(stored.private);
}

export type Generation = { format: 1; generation: number; at: string };

/** The generation recorded for this root, or null when none was. */
export function recordedGeneration(root: string, home: string = homedir()): Generation | null {
  let text: string;
  try {
    text = readFileSync(generationPath(root, home), 'utf8');
  } catch {
    return null;
  }
  try {
    const stored = JSON.parse(text) as Generation;
    if (stored.format !== 1 || !Number.isInteger(stored.generation) || stored.generation < 1 || stored.generation > SAFE_GENERATION) return null;
    return stored;
  } catch {
    return null;
  }
}


/**
 * Moves the generation of this root to the next number and returns it, written
 * atomically before any record: a crash after this and before the record leaves
 * the earlier record stale, which every reader refuses with the repair.
 */
export function bumpGeneration(root: string, home: string, now: Date): number {
  const current = recordedGeneration(root, home)?.generation ?? 0;
  const next = current + 1;
  if (next > SAFE_GENERATION) {
    throw new Error(`${generationPath(root, home)}: the generation is at the safe range's end; approve no further on this machine`);
  }
  writeGeneration(generationPath(root, home), { format: 1, generation: next, at: now.toISOString() });
  return next;
}

function writeGeneration(path: string, generation: Generation): void {
  mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(generation, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// The canonical encoding of a signed record's payload, version 1. Every object
// key is sorted by code point, no whitespace separates the tokens, and nothing
// outside JSON's own grammar appears: an `undefined` is an error, a fractional
// or out-of-range generation is an error, so two different payloads can never
// encode to the same bytes. The domain tag in front keeps a signature over
// these bytes from being a signature over anything else any version writes.
const DOMAIN = 'team-approval-v1\n';

/** The JSON a signature may cover: no undefined, no unsafe number. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, Json>)[key] as Json)}`).join(',')}}`;
  }
  if (typeof value === 'number' && (!Number.isInteger(value) || Math.abs(value) > SAFE_GENERATION)) {
    throw new Error(`the number ${value} is not a safe integer; the canonical encoding takes integers only`);
  }
  return JSON.stringify(value);
}

/** The bytes a signature covers: the domain tag, then the canonical payload. */
export function canonicalPayload(payload: Json): Buffer {
  return Buffer.concat([Buffer.from(DOMAIN, 'utf8'), Buffer.from(canonical(payload), 'utf8')]);
}

export function signPayload(payload: Json, key: KeyObject): string {
  return cryptoSign(null, canonicalPayload(payload), key).toString('hex');
}

/** False for a signature that is not hex, not present, or not the key's. */
export function verifyPayload(payload: Json, signature: string, key: KeyObject): boolean {
  const bytes = canonicalPayload(payload);
  const raw = Buffer.from(signature, 'hex');
  if (raw.length * 2 !== signature.length) return false;
  try {
    return cryptoVerify(null, bytes, createPublicKey(key), raw);
  } catch {
    return false;
  }
}
