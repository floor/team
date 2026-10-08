// The broker's serving half: bind the clone's one socket, check every request against the
// recorded state, dispatch the read, apply the policy, answer one line. The start protocol has
// three answers, pinned by the recon's probe under bun and node: a connect that succeeds means a
// broker already answers (refuse, the caller's exit is nonzero); ECONNREFUSED means a socket
// file left by an unclean death (unlink it, then bind); ENOENT means no file (bind). One lstat
// stands before all three: a path that is not a socket is refused up front — never probed,
// never unlinked (the ubuntu CI read that made this a pinned fork: run 37778336251). A clean
// close removes the file — the runtime owns that, pinned under bun 1.4.2 and node v26.8.1
// (afterBind true, afterClose false) — and a path that cannot bind is a refusal with a code,
// never a crash (a regular file at the path fails under both runtimes: EADDRINUSE under bun,
// EINVAL under node; an over-long path fails under node only — bun binds 207 bytes). The check is the S2 caller
// functions reused verbatim, against the claimed (seat, pane) and the recorded state: integrity
// against a mistaken agent, not authenticity against a hostile one (RFC 008 §5's same-principal
// limit; the page says so).
import { lstatSync, unlinkSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { anotherPaneRefusal, callerVerdict, noPaneRefusal, standingOf, type Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import type { TaskRead, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { applyPolicy, type TaskPolicy } from './policy.ts';
import { MAX_ANSWER_BYTES, MAX_REQUEST_BYTES, brokerSocket, encodeLine, parseRequest, type BrokerAnswer, type BrokerRequest } from './protocol.ts';

/** What one dispatch of the read produced: the adapter's read (with its notice, when the read
 *  was not the whole tracker), or a failure the broker keeps to its own terminal. */
export type BrokerReadResult = { kind: 'read'; read: TaskRead; notice?: string } | { kind: 'failed'; message: string };

export type BrokerReader = () => Promise<BrokerReadResult>;

export type StartBrokerInput = {
  root: string;
  /** The approved team file: the declared seats and the session every request is judged in. */
  team: TeamFile;
  read: BrokerReader;
  policy?: TaskPolicy;
  /** The broker's own one-line failures — a failed read, a broken connection. The owner reads
   *  them where the broker runs; a seat never sees more than the generic refusal. */
  stderr: (text: string) => void;
};

export type BrokerHandle = { close(): Promise<void> };

export type StartBrokerResult =
  | { kind: 'serving'; cleared: boolean; handle: BrokerHandle }
  | { kind: 'busy' }
  | { kind: 'bind-failed'; code?: string };

/** A connection that opens and never sends a line is dropped after this. */
const REQUEST_IDLE_MS = 5000;

/** The one sentence a malformed or over-long request hears — the client never sends one. */
const UNKNOWN_REQUEST = 'the request is not one this broker knows';

/** What the seat hears when a read failed; the detail stays on the broker's terminal. */
const FAILED_READ = 'the broker failed this read';

export async function startBroker(input: StartBrokerInput): Promise<StartBrokerResult> {
  const path = brokerSocket(input.root);
  // The entry, judged by lstat and not by an errno: only a socket belongs to the walk below, and
  // a path holding anything else is refused here, with the pinned bind sentence, untouched —
  // never probed, never unlinked, never bound over. CI's ubuntu runner is why this gate is
  // first (run 37778336251: a regular file answered ECONNREFUSED — Linux's answer where macOS
  // reads ENOTSOCK, myself: bun 1.4.2 + node v26.8.1 — the stale branch then cleared the file
  // and bound, the broker served, and both pinning tests timed out on a refusal that never
  // came). A symlink is "anything else" too: nothing here follows a path someone else planted.
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isSocket()) return { kind: 'bind-failed' };
  const probe = await probeSocket(path);
  if (probe === 'live') return { kind: 'busy' };
  let cleared = false;
  if (probe === 'stale' && isSocketFile(path)) {
    // The path names a socket nothing listens on: an unclean death left it (SIGKILL leaves the
    // file, a clean close does not — both pinned). Clear it, then bind. The re-check above is
    // the gate of the same name; it fails only if the entry changed between the gate and here,
    // and then the bind below answers.
    try {
      unlinkSync(path);
      cleared = true;
    } catch {
      // The bind below answers with its own code.
    }
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    serve(socket, input);
  });
  const failure = await new Promise<{ code?: string } | null>((done) => {
    server.once('error', (error) => done({ code: (error as NodeJS.ErrnoException).code }));
    server.listen(path, () => done(null));
  });
  if (failure) return { kind: 'bind-failed', code: failure.code };
  // A later server-level error must not take the broker down silently.
  server.on('error', (error) => input.stderr(`team broker: ${error.message}\n`));
  const handle: BrokerHandle = {
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
  return { kind: 'serving', cleared, handle };
}

/** The only shape the start walk may clear: a socket file. lstat, never stat — a symlink is left
 *  where it is too, and nothing here follows a path someone else could have planted. */
function isSocketFile(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

type Probe = 'live' | 'stale' | 'none';

/** The three-answer start protocol's read: connect to the path and see which of the three the
 *  answer is. Any error that is not ECONNREFUSED reads as no file; the bind that follows is
 *  what turns that into a concrete answer. */
function probeSocket(path: string): Promise<Probe> {
  return new Promise((done) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      done('live');
    });
    socket.once('error', (error) => {
      socket.destroy();
      done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'stale' : 'none');
    });
  });
}

function serve(socket: Socket, input: StartBrokerInput): void {
  socket.on('error', () => socket.destroy());
  socket.setTimeout(REQUEST_IDLE_MS, () => socket.destroy());
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const at = buffer.indexOf('\n');
    if (at < 0) {
      if (buffer.length > MAX_REQUEST_BYTES) answer(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
      return;
    }
    const line = buffer.slice(0, at);
    buffer = '';
    socket.pause();
    void dispatch(socket, line, input);
  });
}

async function dispatch(socket: Socket, line: string, input: StartBrokerInput): Promise<void> {
  const request = parseRequest(line);
  if (!request) {
    answer(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
    return;
  }
  const refusal = authorize(request, input.team, input.root);
  if (refusal) {
    answer(socket, { ok: false, at: 'caller', message: refusal });
    return;
  }
  let result: BrokerReadResult;
  try {
    result = await input.read();
  } catch (error) {
    input.stderr(`team broker: the read failed: ${error instanceof Error ? error.message : String(error)}\n`);
    answer(socket, { ok: false, at: 'read', message: FAILED_READ });
    return;
  }
  if (result.kind === 'failed') {
    input.stderr(`team broker: the read failed: ${result.message}\n`);
    answer(socket, { ok: false, at: 'read', message: FAILED_READ });
    return;
  }
  const value: BrokerAnswer = { ok: true, read: filtered(result.read, input.policy) };
  if (result.notice !== undefined) value.notice = result.notice;
  answer(socket, value);
}

/** The S2 request check: the claimed name must be a declared seat, and the claimed pane the
 *  pane the state records for it in the team's session — the same functions `team next` uses,
 *  asked about the request. */
function authorize(request: BrokerRequest, team: TeamFile, root: string): string | undefined {
  if (!team.seats.some((seat) => seat.name === request.seat)) return notASeat(request.seat);
  const caller: Caller = { kind: 'seat', name: request.seat, pane: request.pane, session: team.session };
  const verdict = callerVerdict(caller, request.seat, standingOf(join(root, '.agents'), team.session, caller));
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (verdict.kind !== 'ok') return notASeat(request.seat);
  return undefined;
}

function notASeat(seat: string): string {
  return `only a seat of this team pulls a task; this request names ${seat}`;
}

/** The message id rule (`src/commands/messages.ts`), the same token a task id is. The adapter
 *  judges the source's identifier by presence; the id that crosses — after the transform — must
 *  be a task id, so it is judged here, before a record is accepted or a lease is written. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** The policy, applied on this side of the boundary, before the answer is serialized. A record
 *  whose final id is not a task id is refused in the adapter's own shape — the same sentence,
 *  the same keys, the same key order — at the source position of the record it came from, and so
 *  is one whose final id repeats an already-accepted final id: the transform can merge two
 *  distinct source ids into one, and the seat's take must not meet two records under one id
 *  (both adapters enforce this rule on raw ids already). With nothing converted the adapter's
 *  refusal list passes through untouched, so a no-transform run answers byte for byte what it
 *  answered before (fix2 P2). */
function filtered(read: TaskRead, policy?: TaskPolicy): TaskRead {
  if (read.kind !== 'records') return read;
  const taken = new Set(read.refusals.map((refusal) => refusal.index));
  const records: TaskRecord[] = [];
  const converted: TaskRefusal[] = [];
  // Only an accepted final id is remembered, the adapter's own rule: a record refused for its
  // own fault reserves nothing.
  const accepted = new Set<string>();
  read.records.forEach((record, position) => {
    const crossed = applyPolicy(record, policy);
    if (!TASK_ID.test(crossed.id)) {
      converted.push({ index: sourceIndex(position + 1, taken), reason: 'its id is not a task id' });
      return;
    }
    if (accepted.has(crossed.id)) {
      converted.push({ index: sourceIndex(position + 1, taken), id: crossed.id, reason: 'its id repeats an earlier record' });
      return;
    }
    accepted.add(crossed.id);
    records.push(crossed);
  });
  if (converted.length === 0) return { kind: 'records', records, refusals: read.refusals };
  return { kind: 'records', records, refusals: [...read.refusals, ...converted].sort((a, b) => a.index - b.index) };
}

/** The source's 1-based position of its position-th accepted record: the accepted records and
 *  the adapter's refused indexes are two halves of one partition of the source's positions. */
function sourceIndex(position: number, taken: Set<number>): number {
  let index = 0;
  let left = position;
  while (left > 0) {
    index += 1;
    if (!taken.has(index)) left -= 1;
  }
  return index;
}

function answer(socket: Socket, value: BrokerAnswer): void {
  const line = encodeLine(value);
  if (line.length > MAX_ANSWER_BYTES) {
    socket.end(encodeLine({ ok: false, at: 'read', message: FAILED_READ }));
    return;
  }
  socket.end(line);
}
