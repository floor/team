// `team messages`: verify a record that is already waiting, print its body, and write the receipt.
// Nothing in this build writes the first real record. A report still leaves as the watch's nudge.
// The signature is integrity: every seat runs as the owner-user, so it is not proof of who sent it.
import { type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { findRoot, loadTeamFile, NOT_A_REPO } from '../file/load.ts';
import type { Command, Io } from '../io.ts';
import { writeAtomic } from '../state.ts';
import {
  messageKeyOf,
  messageKeyState,
  MESSAGE_DOMAIN,
  RECEIPT_DOMAIN,
  signDomain,
  verifyDomain,
  type Json,
} from '../store/keys.ts';

export const USAGE = 'Usage: team messages\n';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export type MessagePayload = {
  kind: 'message';
  id: string;
  to: string;
  root: string;
  session: string;
  at: string;
  body: string;
  from: string;
};

export type ReceiptPayload = {
  kind: 'receipt';
  id: string;
  to: string;
  root: string;
  session: string;
  at: string;
};

export type MessagesSources = {
  home: string;
  now(): Date;
};

export const realSources: MessagesSources = { home: homedir(), now: () => new Date() };

export const messages: Command = (argv, io) => runMessages(argv, io, realSources);
export default messages;

/** `.agents/messages/<seat>/<id>.json`. The filename is the id; the directory is the recipient. */
export function messageFile(root: string, seat: string, id: string): string {
  return join(root, '.agents', 'messages', seat, `${id}.json`);
}

export function receiptFile(root: string, seat: string, id: string): string {
  return join(root, '.agents', 'messages', seat, `${id}.read.json`);
}

type Candidate = { seat: string; id: string; path: string };

export type Unacked = { id: string; to: string; at: string };

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

/** The payload a message signature covers, or null when the file is not that shape. */
function messagePayload(value: unknown): MessagePayload | null {
  if (!isRecord(value)) return null;
  const payload = value.payload;
  if (!isRecord(payload)) return null;
  if (payload.kind !== 'message') return null;
  if (!text(payload.id) || !text(payload.to) || !text(payload.root) || !text(payload.session)) return null;
  if (!text(payload.at) || !text(payload.body) || !text(payload.from)) return null;
  if (!text(value.signature)) return null;
  return payload as MessagePayload;
}

function receiptMatches(path: string, seat: string, id: string, root: string, session: string, key: KeyObject): boolean {
  if (!isFile(path)) return false;
  const parsed = readJson(path);
  if (!isRecord(parsed) || !isRecord(parsed.payload) || !text(parsed.signature)) return false;
  const payload = parsed.payload;
  if (payload.kind !== 'receipt') return false;
  if (payload.id !== id || payload.to !== seat || payload.session !== session) return false;
  if (!text(payload.root) || !samePath(payload.root, root)) return false;
  if (!text(payload.at)) return false;
  return verifyDomain(RECEIPT_DOMAIN, payload as Json, parsed.signature, key);
}

function candidates(root: string): Candidate[] {
  const dir = join(root, '.agents', 'messages');
  if (!isDir(dir)) return [];
  const out: Candidate[] = [];
  for (const seat of readdirSync(dir).sort()) {
    if (!NAME.test(seat)) continue;
    const seatDir = join(dir, seat);
    if (!isDir(seatDir)) continue;
    for (const name of readdirSync(seatDir).sort()) {
      if (!name.endsWith('.json') || name.endsWith('.read.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!NAME.test(id)) continue;
      const path = join(seatDir, name);
      if (!isFile(path)) continue;
      out.push({ seat, id, path });
    }
  }
  return out;
}

/**
 * Records with no verifying receipt. A missing message key yields nothing: a signature cannot
 * be checked, and this read does not create the key. The watch rings from this list.
 */
export function listUnacked(root: string, session: string, home: string): Unacked[] {
  const state = messageKeyState(home);
  if (state.kind !== 'key') return [];
  const out: Unacked[] = [];
  for (const candidate of candidates(root)) {
    if (receiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key)) continue;
    const parsed = readJson(candidate.path);
    const payload = messagePayload(parsed);
    if (!payload || !isRecord(parsed) || !text(parsed.signature)) continue;
    if (payload.id !== candidate.id || payload.to !== candidate.seat) continue;
    if (payload.session !== session || !samePath(payload.root, root)) continue;
    if (!verifyDomain(MESSAGE_DOMAIN, payload as Json, parsed.signature, state.key)) continue;
    out.push({ id: candidate.id, to: candidate.seat, at: payload.at });
  }
  return out;
}

/**
 * Writes one record the way a sender would, signing with the message key. The message key is
 * created here when it does not exist yet. Tests and the evidence harness are the only callers;
 * no command writes a record.
 */
export function plantMessage(home: string, root: string, seat: string, id: string, payload: MessagePayload, signature?: string): void {
  const key = messageKeyOf(home);
  const signed = signature ?? signDomain(MESSAGE_DOMAIN, payload as Json, key);
  const path = messageFile(root, seat, id);
  mkdirSync(join(root, '.agents', 'messages', seat), { recursive: true });
  writeAtomic(path, `${JSON.stringify({ payload, signature: signed }, null, 2)}\n`);
}

type Problem = { kind: 'shape' | 'id' | 'seat' | 'root' | 'session' | 'signature'; text: string };

function problemOf(candidate: Candidate, root: string, session: string, key: KeyObject): Problem | MessagePayload {
  const where = `${candidate.seat}/${candidate.id}`;
  const parsed = readJson(candidate.path);
  const payload = messagePayload(parsed);
  if (!payload || !isRecord(parsed)) return { kind: 'shape', text: `${where} does not verify: the record is not a message` };
  if (payload.id !== candidate.id) {
    return { kind: 'id', text: `${where} does not verify: its id is ${payload.id}, and the filename is the id` };
  }
  if (payload.to !== candidate.seat) {
    return { kind: 'seat', text: `${where} does not verify: it is addressed to ${payload.to}` };
  }
  if (!samePath(payload.root, root)) {
    return { kind: 'root', text: `${where} does not verify: it is bound to another checkout` };
  }
  if (payload.session !== session) {
    return { kind: 'session', text: `${where} does not verify: it is bound to session ${JSON.stringify(payload.session)}` };
  }
  if (!verifyDomain(MESSAGE_DOMAIN, payload as Json, parsed.signature as string, key)) {
    return { kind: 'signature', text: `${where} does not verify: the signature is not the message key's` };
  }
  return payload;
}

function writeReceipt(home: string, root: string, payload: MessagePayload, at: string): void {
  const receipt: ReceiptPayload = {
    kind: 'receipt',
    id: payload.id,
    to: payload.to,
    root: payload.root,
    session: payload.session,
    at,
  };
  const key = messageKeyState(home);
  if (key.kind !== 'key') throw new Error('the message key disappeared before the receipt was signed');
  const signature = signDomain(RECEIPT_DOMAIN, receipt as Json, key.key);
  writeAtomic(receiptFile(root, payload.to, payload.id), `${JSON.stringify({ payload: receipt, signature }, null, 2)}\n`);
}

/**
 * Verifies every unacked record, prints each body that verifies, and writes its receipt in the
 * same step. A record that does not verify prints no body and writes nothing. An empty mailbox
 * prints one line and creates no key. Anyone in the checkout may run it: the ring asks the
 * recipient's pane, and the receipt records that a process was shown the body.
 */
export async function runMessages(argv: string[], io: Io, sources: MessagesSources = realSources): Promise<number> {
  const args = readArgs(argv, [], []);
  if (args.error || args.rest.length) {
    io.stderr(`team messages: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: messages.invocation
    return 2;
  }
  const root = findRoot(io.cwd);
  if (!root) {
    io.stderr(`team messages: ${NOT_A_REPO}\n`);
    // exit: messages.not-a-repo
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const message = loaded.errors[0]?.message ?? 'the team file can\'t be read';
    io.stderr(`team messages: ${message}\n`);
    // exit: messages.file
    return 1;
  }
  const session = loaded.team.session;
  const state = messageKeyState(sources.home);
  const waiting = candidates(root).filter((candidate) => {
    if (state.kind !== 'key') return true;
    return !receiptMatches(receiptFile(root, candidate.seat, candidate.id), candidate.seat, candidate.id, root, session, state.key);
  });
  if (waiting.length === 0) {
    io.stdout('team messages: nothing is waiting\n');
    // exit: messages.none
    return 0;
  }
  if (state.kind !== 'key') {
    const why = state.kind === 'missing' ? 'no message key; nothing was shown' : `${state.why}; nothing was shown`;
    io.stderr(`team messages: ${why}\n`);
    // exit: messages.key
    return 1;
  }
  let failed = false;
  for (const candidate of waiting) {
    const result = problemOf(candidate, root, session, state.key);
    if ('text' in result) {
      io.stderr(`team messages: ${result.text}\n`);
      failed = true;
      continue;
    }
    // The receipt means the body was shown. `io.stdout` returning is that boundary: a throw
    // leaves no receipt, and the record stays unacked.
    io.stdout(result.body.endsWith('\n') ? result.body : `${result.body}\n`);
    writeReceipt(sources.home, root, result, sources.now().toISOString());
  }
  if (failed) {
    // exit: messages.shape
    // exit: messages.id
    // exit: messages.seat
    // exit: messages.root
    // exit: messages.session
    // exit: messages.signature
    return 1;
  }
  // exit: messages.shown
  return 0;
}
