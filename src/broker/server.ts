// The broker's serving half: bind the clone's one socket, check every request against the
// recorded state, dispatch the read, apply the policy, answer one line. The start protocol has
// three answers, pinned by the recon's probe under bun and node: a connect that succeeds means a
// broker already answers (refuse, the caller's exit is nonzero); ECONNREFUSED means a socket
// file left by an unclean death (unlink it — only when it is still the very entry the probe saw,
// and only once that entry has answered stale twice with a turn between — then bind); ENOENT
// means no file (bind). One lstat stands before all three: a path that is
// not a socket is refused up front — never probed, never unlinked (the ubuntu CI read that made
// this a pinned fork: run 37778336251). A clean
// close removes the file — the runtime owns that, pinned under bun 1.4.2 and node v26.8.1
// (afterBind true, afterClose false) — and a path that cannot bind is a refusal with a code,
// never a crash (a regular file at the path fails under both runtimes: EADDRINUSE under bun,
// EINVAL under node; an over-long path fails under node only — bun binds 207 bytes). The check is the S2 caller
// functions reused verbatim, against the claimed (seat, pane) and the recorded state: integrity
// against a mistaken agent, not authenticity against a hostile one (RFC 008 §5's same-principal
// limit; the page says so).
//
// The whole start section — the lstat gate, the probe, the clear, the bind, the listen — runs
// under one lock beside the socket (`.agents/broker.sock.lock`, never at the socket path
// itself), so two starts in two processes serialize instead of racing a path one of them is
// still on its way to binding (the pin: a real owner held pre-listen, a second real start
// spawned mid-hold — the owner serves, the second waits and reads it live). The lock file holds
// its holder's pid and carries `withLock`'s discipline from `src/state.ts` — exclusive create,
// a lock whose holder is dead taken over — written as an await loop because this section spans
// awaits, where `withLock` busy-waits; `withLock` itself is untouched. A start whose wait
// outlasts the deadline answers `locked`: refused, nothing cleared, nothing bound. The lock is
// released when the listen lands and on every other way out of the section.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { anotherPaneRefusal, callerVerdict, noPaneRefusal, standingOf, type Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import type { TaskRead, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { applyPolicy, bareRefusalId, type TaskPolicy } from './policy.ts';
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
  | { kind: 'bind-failed'; code?: string }
  | { kind: 'locked' };

/** A connection that opens and never sends a line is dropped after this. */
const REQUEST_IDLE_MS = 5000;

/** The one sentence a malformed or over-long request hears — the client never sends one. */
const UNKNOWN_REQUEST = 'the request is not one this broker knows';

/** What the seat hears when a read failed; the detail stays on the broker's terminal. */
const FAILED_READ = 'the broker failed this read';

/** A start that keeps losing the clear race re-walks the three answers this many times; the
 *  bound ends on the pinned bare bind sentence instead of looping. */
const START_WALKS = 8;

/** A stale answer is confirmed only when the same entry answers stale again after this turn:
 *  a fresh sibling socket answers ECONNREFUSED for a moment before its owner's listen takes
 *  effect (CI's ubuntu runner, run 37787613018: two concurrent starts both served — the second
 *  probed the first's fresh socket "stale" where macOS already read it live). */
const STALE_CONFIRM_MS = 50;

/** How long a start waits on the start lock's live holder before it refuses. It must outlast a
 *  sibling start's whole section (the pin holds one for 1500ms and the waiter still wins the
 *  lock), and it fails closed: past this, the pinned `locked` answer, nothing touched. */
const LOCK_WAIT_MS = 2000;

/** The wait's poll cadence, and the pause before re-reading a lock too young to hold its pid —
 *  `withLock`'s own 50 and 20. */
const LOCK_POLL_MS = 50;
const LOCK_YOUNG_MS = 1000;

/** `withLock`'s read of "the holder is still running" (it is not exported; the discipline is
 *  mirrored here, not imported): a pid that answers signal 0, with EPERM — another user's live
 *  process — counting alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `withLock`'s takeover: the file is moved aside first, which only one of two starters can do,
 *  and put back if the move revealed a fresh live holder another starter took in between. */
function takeOverLock(path: string, holder: number): boolean {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  const found = Number(readFileSync(aside, 'utf8').trim());
  if (found !== holder && Number.isInteger(found) && found > 0 && alive(found)) {
    try {
      renameSync(aside, path);
    } catch {}
    return false;
  }
  unlinkSync(aside);
  return true;
}

/** The start section's lock, `withLock`'s discipline awaited instead of busy-waited: exclusive
 *  create with the holder's pid written, a live holder waited for until the deadline (answered
 *  `timeout`, which the caller refuses), a dead or too-young-to-hold-pid lock taken over. The
 *  file's directory is made the way `withLock` makes its own. */
async function acquireStartLock(path: string): Promise<{ kind: 'held'; release: () => void } | { kind: 'timeout' }> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return {
        kind: 'held',
        // `withLock`'s own release: the file this hold created, gone. A dead holder never
        // reaches here — its lock is taken over by the next start — and a live hold is never
        // taken over, so the unlink is this hold's file.
        release: () => {
          try {
            unlinkSync(path);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        continue; // released between the two calls
      }
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        if (Date.now() > deadline) return { kind: 'timeout' };
        await new Promise((tick) => setTimeout(tick, LOCK_POLL_MS));
        continue;
      }
      // A dead holder, or a lock file too young to hold its pid yet.
      if (!Number.isInteger(holder) && Date.now() - statSync(path).mtimeMs < LOCK_YOUNG_MS) {
        await new Promise((tick) => setTimeout(tick, 20));
        continue;
      }
      takeOverLock(path, holder);
    }
  }
}

export async function startBroker(input: StartBrokerInput): Promise<StartBrokerResult> {
  const path = brokerSocket(input.root);
  const lock = await acquireStartLock(`${path}.lock`);
  if (lock.kind === 'timeout') return { kind: 'locked' };
  try {
    // The lock is held through the whole walk, and released — here, on every return and on a
    // throw — the moment the section is over: for a serve, as the listen lands.
    return await startWalk(input, path);
  } finally {
    lock.release();
  }
}

async function startWalk(input: StartBrokerInput, path: string): Promise<StartBrokerResult> {
  // The entry the previous walk saw a stale answer on, awaiting a second sighting.
  let confirmed: { dev: number; ino: number } | undefined;
  for (let walk = 0; walk < START_WALKS; walk++) {
    // The entry, judged by lstat and not by an errno: only a socket belongs to the walk below,
    // and a path holding anything else is refused here, with the pinned bind sentence, untouched
    // — never probed, never unlinked, never bound over. CI's ubuntu runner is why this gate is
    // first (run 37778336251: a regular file answered ECONNREFUSED — Linux's answer where macOS
    // reads ENOTSOCK, myself: bun 1.4.2 + node v26.8.1 — the stale branch then cleared the file
    // and bound, the broker served, and both pinning tests timed out on a refusal that never
    // came). A symlink is "anything else" too: nothing here follows a path someone else planted.
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isSocket()) return { kind: 'bind-failed' };
    const probe = await probeSocket(path);
    if (probe === 'live') return { kind: 'busy' };
    let cleared = false;
    if (probe === 'stale') {
      // The path named a socket nothing listens on. Only that very entry may be cleared: the
      // identity captured at the gate above (dev+ino, lstat and never stat — nothing here
      // follows a path someone else could have planted) must still be the entry here, and it
      // must have answered stale on the previous walk too, with a loop turn in between. An
      // unclean death leaves the file (SIGKILL leaves it, a clean close does not — both
      // pinned) and keeps answering stale; a sibling start's fresh socket answers stale only
      // until its listen lands, so it is never cleared on one sighting. A changed entry is
      // never unlinked — the walk reads it instead, and its own three answers decide.
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (!entry || !current || current.dev !== entry.dev || current.ino !== entry.ino) {
        confirmed = undefined;
        continue;
      }
      if (!confirmed || confirmed.dev !== entry.dev || confirmed.ino !== entry.ino) {
        confirmed = { dev: entry.dev, ino: entry.ino };
        await new Promise<void>((done) => setTimeout(done, STALE_CONFIRM_MS));
        continue;
      }
      confirmed = undefined;
      try {
        unlinkSync(path);
        cleared = true;
      } catch {
        // Gone under us between the identity check and the unlink: walk again rather than bind
        // over an entry that is not the one the probe saw.
        continue;
      }
    } else {
      confirmed = undefined;
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
  return { kind: 'bind-failed' };
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
 *  (both adapters enforce this rule on raw ids already). The transform governs a refusal's id
 *  too, by the same rule (the id is the source's own reference). With nothing converted and no
 *  refusal's id transformed, the adapter's refusal list passes through untouched, so a
 *  no-transform run answers byte for byte what it answered before (fix2 P2). */
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
  const refusals = policy?.transform?.id === 'bare' ? read.refusals.map((refusal) => crossedRefusal(refusal)) : read.refusals;
  if (converted.length === 0 && refusals === read.refusals) return { kind: 'records', records, refusals: read.refusals };
  return { kind: 'records', records, refusals: [...refusals, ...converted].sort((a, b) => a.index - b.index) };
}

/** A refusal's id under the same policy: crossed by the transform, or omitted when the raw id
 *  has no segment to cross — the raw one never rides in a refusal. A refusal with no id is
 *  unchanged. */
function crossedRefusal(refusal: TaskRefusal): TaskRefusal {
  if (refusal.id === undefined) return refusal;
  const id = bareRefusalId(refusal.id);
  if (id === undefined) return { index: refusal.index, reason: refusal.reason };
  return { index: refusal.index, id, reason: refusal.reason };
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
