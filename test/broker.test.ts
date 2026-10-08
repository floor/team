// The broker boundary over a real unix socket in a scratch directory: the protocol's strict
// parsers, the three-answer start protocol, the S2 request check, the per-field policy, and the
// seat's client outcomes. The credential is a deliberate non-real string and the tracker is an
// answer map, the release world's shape — no test here reads the Keychain or opens a network
// connection. The child that leaves a stale socket is killed with SIGKILL, the probe's own pin:
// a clean close removes the file, a kill leaves it (probe run under bun 1.4.2 and node v26.8.1:
// afterBind true, afterClose false on both).
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anotherPaneRefusal, noPaneRefusal } from '../src/caller.ts';
import { runBroker, type BrokerSources } from '../src/commands/broker.ts';
import { askBroker, BROKER_DEADLINE_MS, DEADLINE, NOT_RUNNING, WRONG_ANSWER, type BrokerOutcome } from '../src/broker/client.ts';
import { applyPolicy, type TaskPolicy } from '../src/broker/policy.ts';
import { brokerSocket, encodeLine, MAX_REQUEST_BYTES, parseAnswer, parseRequest, type BrokerAnswer, type BrokerRequest } from '../src/broker/protocol.ts';
import { startBroker, type BrokerReadResult, type BrokerReader } from '../src/broker/server.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Attempt, Fetch, RequestOptions } from '../src/release/http.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { TaskRecord, TaskRefusal } from '../src/tasks/adapter.ts';
import { testIo } from './helpers.ts';

const PROJECT = '01234567-89ab-cdef-0123-456789abcdef';
const KEY = 'test-key-not-real';

const LINEAR = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "1"
    launch: codex
tasks:
  source: linear
  linear:
    project: ${PROJECT}
    keychainService: team.linear.acme
`;

const FILE_SOURCE = LINEAR.replace('  source: linear', '  source: file').replace(/  linear:\n    project: .*\n    keychainService: .*\n/, '  path: .agents/tasks.yaml\n');

const leadSeat: BrokerRequest = { op: 'read', seat: 'lead', pane: 'w1:p1' };
const workerSeat: BrokerRequest = { op: 'read', seat: 'worker', pane: 'w2:p1' };

let base: string;
let root: string;
let home: string;

afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const openHandles: { close(): Promise<void> }[] = [];

/** A clone with the linear fixture: git-initialized, the team file in `.agents`, its own home. */
function project(text = LINEAR): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-broker-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

/** The state the S2 check reads: both seats recorded, on their panes. */
function record(): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function teamOf(text = LINEAR): TeamFile {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  return checked.team;
}

function records(list: TaskRecord[], refusals: TaskRefusal[] = []): BrokerReadResult {
  return { kind: 'read', read: { kind: 'records', records: list, refusals } };
}

async function serving(read: BrokerReader, policy?: TaskPolicy): Promise<{ handle: { close(): Promise<void> }; stderr: string[] }> {
  const lines: string[] = [];
  const started = await startBroker({
    root,
    team: teamOf(),
    read,
    ...(policy ? { policy } : {}),
    stderr: (text) => lines.push(text),
  });
  if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
  openHandles.push(started.handle);
  return { handle: started.handle, stderr: lines };
}

function ask(request: BrokerRequest, deadlineMs?: number): Promise<BrokerOutcome> {
  return askBroker(root, request, deadlineMs === undefined ? {} : { deadlineMs });
}

/** One raw request line over the socket, with the answer line back — the probe reads the wire
 *  the way a foreign caller would, without the client's parsers. */
function send(line: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(brokerSocket(root));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => {
      socket.destroy();
      fail(new Error('the broker did not answer'));
    });
    socket.once('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      socket.destroy();
      done(buffer.slice(0, at));
    });
    socket.once('error', fail);
  });
}

/** A plain listener on the clone's socket path, for the answers the client must fail safe on.
 *  It is closed with its connections: bun's node:net server has no `closeAllConnections`. */
async function rawServer(handler: (socket: Socket) => void): Promise<() => Promise<void>> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    handler(socket);
  });
  await new Promise<void>((done) => server.listen(brokerSocket(root), () => done()));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  throw new Error('the condition never held');
}

/** A socket file with no listener behind it, left the way an unclean death leaves one: a child
 *  binds it and SIGKILLs itself. The recon pinned this under bun and node: the file stays, and a
 *  connect to it answers ECONNREFUSED. */
function leaveStaleSocket(): void {
  const script = join(base, 'stale.mjs');
  writeFileSync(script, "import net from 'node:net';\nconst server = net.createServer();\nserver.listen(process.argv[2], () => process.kill(process.pid, 'SIGKILL'));\n");
  try {
    execFileSync(process.execPath, [script, brokerSocket(root)], { stdio: 'ignore' });
  } catch (error) {
    if ((error as { signal?: string }).signal !== 'SIGKILL') throw error;
  }
}

/** The answer map, the release world's shape: one recorded attempt, every request kept. */
function tracker(value: unknown): { fetch: Fetch; requests: { url: string; request?: RequestOptions }[] } {
  const requests: { url: string; request?: RequestOptions }[] = [];
  const fetch: Fetch = (url, request) => {
    requests.push(request === undefined ? { url } : { url, request });
    const attempt: Attempt = { kind: 'http', status: 200, body: JSON.stringify(value) };
    return Promise.resolve(attempt);
  };
  return { fetch, requests };
}

function issuesAnswer(nodes: unknown[], hasNextPage: unknown = false): Record<string, unknown> {
  return { data: { project: { id: PROJECT, issues: { nodes, pageInfo: { hasNextPage } } } } };
}

function node(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { identifier: 'ACME-1', title: 'a task', description: 'the body', ...change };
}

/** The command's seams without the terminal: a literal key, the answer map, and a stop the test
 *  holds. Production's own wiring is never exercised here. */
async function startCommand(seams: BrokerSources = {}): Promise<{ running: Promise<number>; io: ReturnType<typeof testIo>; finish: () => void }> {
  const io = testIo(root);
  let finish!: () => void;
  const running = runBroker([], io, {
    home,
    keyReader: async () => ({ ok: true, key: KEY }),
    stop: (end) => {
      finish = end;
      return () => {};
    },
    ...seams,
  });
  await waitFor(() => io.err.includes('answering on') || io.err.includes('team broker: '));
  return { running, io, finish };
}

describe('the broker wire protocol', () => {
  test('a request is exactly the three keys this build writes', () => {
    expect(parseRequest(JSON.stringify({ op: 'read', seat: 'lead', pane: 'w1:p1' }))).toEqual(leadSeat);
    for (const line of [
      'not json',
      JSON.stringify({ op: 'read', seat: 'lead', pane: 'w1:p1', token: 'x' }),
      JSON.stringify({ op: 'read', seat: 'lead' }),
      JSON.stringify({ op: 'write', seat: 'lead', pane: 'w1:p1' }),
      JSON.stringify({ op: 'read', seat: '', pane: 'w1:p1' }),
      JSON.stringify({ op: 'read', seat: 'a'.repeat(201), pane: 'w1:p1' }),
      JSON.stringify({ op: 'read', seat: 'lead\nworker', pane: 'w1:p1' }),
      JSON.stringify([{ op: 'read', seat: 'lead', pane: 'w1:p1' }]),
    ]) {
      expect(parseRequest(line)).toBeNull();
    }
  });

  test('an answer this build did not write is refused, never half-read', () => {
    const read: BrokerAnswer = { ok: true, read: { kind: 'records', records: [{ id: 'm1', title: 't', priority: 1 }], refusals: [{ index: 2, id: 'm2', reason: 'title is required' }] } };
    expect(parseAnswer(encodeLine(read).trimEnd())).toEqual(read);
    const withNotice: BrokerAnswer = { ...read, notice: 'more' };
    expect(parseAnswer(encodeLine(withNotice).trimEnd())).toEqual(withNotice);
    const refused: BrokerAnswer = { ok: false, at: 'caller', message: 'no' };
    expect(parseAnswer(encodeLine(refused).trimEnd())).toEqual(refused);
    expect(parseAnswer(encodeLine({ ok: true, read: { kind: 'missing' } } as BrokerAnswer).trimEnd())).toEqual({ ok: true, read: { kind: 'missing' } });
    for (const line of [
      'not json',
      JSON.stringify({ ok: true, read: { kind: 'missing', junk: 1 } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [], refusals: [], junk: 1 } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [{ id: 'm1' }], refusals: [] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [{ id: 'm1', title: 't', extra: 1 }], refusals: [] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [{ id: 'm1', title: 't', priority: true }], refusals: [] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [], refusals: [{ index: 0, reason: 'x' }] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [], refusals: [], notice: '' } }),
      JSON.stringify({ ok: false, at: 'somewhere', message: 'no' }),
      JSON.stringify({ ok: 'yes', read: { kind: 'missing' } }),
      JSON.stringify({ ok: true }),
    ]) {
      expect(parseAnswer(line)).toBeNull();
    }
  });

  test('a line over the cap without its newline is refused, not buffered forever', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 't' }]));
    const line = `{"op":"read","seat":"lead","pane":"${'x'.repeat(MAX_REQUEST_BYTES)}"}`;
    const answer = await send(line);
    expect(JSON.parse(answer)).toEqual({ ok: false, at: 'caller', message: 'the request is not one this broker knows' });
  });
});

describe('the seat\'s client outcomes', () => {
  test('the sentences are bytes, and the deadline is the release check\'s', () => {
    expect(NOT_RUNNING).toBe('the broker is not running; the owner starts it with `team broker`');
    expect(WRONG_ANSWER).toBe("the broker's answer is not one this build knows; the owner restarts it");
    expect(DEADLINE).toBe('the broker accepted the request and did not answer; nothing is claimed');
    expect(BROKER_DEADLINE_MS).toBe(5000);
  });

  test('no broker, no socket file: unavailable', async () => {
    project();
    record();
    expect(await ask(leadSeat)).toEqual({ kind: 'unavailable' });
  });

  test('an answer line this build does not know is wrong, never half-read', async () => {
    project();
    record();
    const lines = ['not json\n', '{"ok":true,"read":{"kind":"records","records":[{"id":"m1"}],"refusals":[]}}\n'];
    for (const line of lines) {
      const close = await rawServer((socket) => socket.end(line));
      try {
        expect(await ask(leadSeat)).toEqual({ kind: 'wrong' });
      } finally {
        await close();
      }
    }
  });

  test('a broker that accepts and never answers is a deadline, and nothing is claimed', async () => {
    project();
    record();
    const close = await rawServer(() => {});
    try {
      expect(await ask(leadSeat, 200)).toEqual({ kind: 'deadline' });
    } finally {
      await close();
    }
  });
});

describe('the start protocol', () => {
  test('a second broker refuses as busy, through the module and through the command', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 't' }]));
    expect(await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([])), stderr: () => {} })).toEqual({ kind: 'busy' });
    const { running, io } = await startCommand();
    expect(await running).toBe(1);
    expect(io.err).toContain('team broker: a broker is already answering on .agents/broker.sock\n');
  });

  test('a socket file left by a SIGKILL is cleared and bound', async () => {
    project();
    record();
    leaveStaleSocket();
    const path = brokerSocket(root);
    expect(existsSync(path)).toBe(true);
    const started = await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
    if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
    expect(started.cleared).toBe(true);
    const outcome = await ask(leadSeat);
    expect(outcome).toMatchObject({ kind: 'read' });
    await started.handle.close();
    expect(existsSync(path)).toBe(false);
  });

  test('a path that cannot bind is a line and exit 1, not a crash, and the file stays', async () => {
    // A regular file where the socket belongs: the probe reads it as no socket, and the bind
    // fails under both runtimes (probe run under bun 1.4.2: EADDRINUSE; node v26.8.1: EINVAL).
    // The probe also showed an over-long path fails under node only — bun binds it, 207 bytes —
    // so neither path length nor an error code is pinned here; the failing file is the pin.
    project();
    const path = brokerSocket(root);
    writeFileSync(path, 'not a socket');
    const io = testIo(root);
    const code = await runBroker([], io, { home, keyReader: async () => ({ ok: true, key: KEY }) });
    expect(code).toBe(1);
    expect(io.err.startsWith('team broker: the socket could not be bound')).toBe(true);
    expect(io.err).not.toContain('at Object');
    expect(io.out).toBe('');
    // Fail closed: the probe read no socket, and the refusal never unlinks the file.
    expect(readFileSync(path, 'utf8')).toBe('not a socket');
  });
});

describe('the per-request check', () => {
  test('every request is held to the recorded state, with the S2 sentences', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 'the task title' }]));
    expect(await ask({ op: 'read', seat: 'stranger', pane: 'w9:p1' })).toEqual({
      kind: 'refused',
      at: 'caller',
      message: 'only a seat of this team pulls a task; this request names stranger',
    });
    expect(await ask({ op: 'read', seat: 'lead', pane: 'w2:p1' })).toEqual({
      kind: 'refused',
      at: 'caller',
      message: anotherPaneRefusal('lead', 'w1:p1'),
    });
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready' };
    });
    expect(await ask(leadSeat)).toEqual({ kind: 'refused', at: 'caller', message: noPaneRefusal('lead') });
    expect(await ask(workerSeat)).toMatchObject({ kind: 'read' });
  });

  test('a request line that is not one this build wrote is a refusal, never a crash', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 'the task title' }]));
    for (const line of ['hello\n', '{"op":"read","seat":"lead","pane":"w1:p1","token":"x"}\n', '{"op":"read"}\n', '\n']) {
      const answer = JSON.parse(await send(line)) as BrokerAnswer;
      expect(answer).toEqual({ ok: false, at: 'caller', message: 'the request is not one this broker knows' });
    }
  });
});

describe('the per-field policy', () => {
  const full: TaskRecord = {
    id: 'ACME-1',
    title: 'a task',
    priority: 1,
    assignee: 'worker',
    milestone: 'M1',
    deadline: '2026-10-31',
    blockedBy: ['ACME-0'],
    repos: ['acme'],
    needs: ['review'],
    description: 'the body',
  };

  test('with no policy the nine typed fields cross and the description does not', () => {
    const out = applyPolicy(full);
    expect(out).toEqual({
      id: 'ACME-1',
      title: 'a task',
      priority: 1,
      assignee: 'worker',
      milestone: 'M1',
      deadline: '2026-10-31',
      blockedBy: ['ACME-0'],
      repos: ['acme'],
      needs: ['review'],
    });
    expect('description' in out).toBe(false);
  });

  test('an omitted field is absent from the record, never blank', () => {
    const out = applyPolicy(full, { omit: ['assignee', 'description'] });
    expect('assignee' in out).toBe(false);
    expect('description' in out).toBe(false);
    expect(out.deadline).toBe('2026-10-31');
  });

  test('allow names the set, and id and title stay the record itself', () => {
    expect(applyPolicy(full, { allow: ['id', 'title'] })).toEqual({ id: 'ACME-1', title: 'a task' });
    expect(applyPolicy(full, { allow: ['id', 'title', 'description'] })).toEqual({ id: 'ACME-1', title: 'a task', description: 'the body' });
    // The invariant holds whichever way the policy is called, even bypassing the validator.
    expect(applyPolicy(full, { allow: [] })).toEqual({ id: 'ACME-1', title: 'a task' });
    // Naming them in `omit` changes nothing: the two cross regardless.
    const omitted = applyPolicy(full, { omit: ['id', 'title'] });
    expect(omitted.id).toBe('ACME-1');
    expect(omitted.title).toBe('a task');
    expect('description' in omitted).toBe(false);
  });

  test('id: bare keeps the last URL segment', () => {
    const url = { ...full, id: 'https://linear.app/acme/issue/ACME-1/a-title' };
    expect(applyPolicy(url, { transform: { id: 'bare' } }).id).toBe('a-title');
    expect(applyPolicy({ ...full, id: 'ACME-1' }, { transform: { id: 'bare' } }).id).toBe('ACME-1');
  });

  test('the policy is applied before the answer is serialized, not by the seat', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'ACME-1', title: 'a task', description: 'the body', priority: 1 }]), { allow: ['id', 'title'] });
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(line).not.toContain('the body');
    expect(line).not.toContain('description');
    const answer = parseAnswer(line);
    expect(answer).toEqual({ ok: true, read: { kind: 'records', records: [{ id: 'ACME-1', title: 'a task' }], refusals: [] } });
  });

  test('a failed read keeps its detail on the broker\'s terminal and tells the seat the one line', async () => {
    project();
    record();
    let call = 0;
    const { stderr } = await serving(async () => {
      call += 1;
      if (call === 1) return { kind: 'failed', message: 'the tracker could not be read' };
      throw new Error('boom');
    });
    expect(await ask(leadSeat)).toEqual({ kind: 'refused', at: 'read', message: 'the broker failed this read' });
    expect(await ask(leadSeat)).toEqual({ kind: 'refused', at: 'read', message: 'the broker failed this read' });
    expect(stderr).toEqual(['team broker: the read failed: the tracker could not be read\n', 'team broker: the read failed: boom\n']);
  });
});

describe('the tasks section under the broker source', () => {
  const of = (extra: string): string => `${LINEAR}${extra}`;

  test('source: linear validates with its block, and omitted keys stay absent', () => {
    const plain = validateTeamFile(LINEAR);
    if (!plain.ok) throw new Error('the fixture does not validate');
    expect(plain.team.tasks).toEqual({ source: 'linear', linear: { project: PROJECT, keychainService: 'team.linear.acme' } });
    const withPolicy = validateTeamFile(of('  policy:\n    omit: [description]\n    transform:\n      id: bare\n'));
    if (!withPolicy.ok) throw new Error('the policy fixture does not validate');
    expect(withPolicy.team.tasks).toEqual({
      source: 'linear',
      linear: { project: PROJECT, keychainService: 'team.linear.acme' },
      policy: { omit: ['description'], transform: { id: 'bare' } },
    });
  });

  test('every refusal sentence of the table is a byte', () => {
    const fileWithPolicy = `${FILE_SOURCE}  policy:\n    omit: [description]\n`;
    expect(refusals(fileWithPolicy)).toContain('tasks.policy is for a broker source; source: file has no broker');
    const fileWithLinear = `${FILE_SOURCE}  linear:\n    project: x\n    keychainService: y\n`;
    expect(refusals(fileWithLinear)).toContain('tasks.linear is for source: linear');
    expect(refusals(of('  policy:\n    allow: [id, title]\n    omit: [description]\n'))).toContain('tasks.policy: allow and omit are not used together');
    expect(refusals(of('  policy:\n    allow: [id, title, foo]\n'))).toContain('tasks.policy.allow lists "foo", not a task field');
    expect(refusals(of('  policy:\n    omit: [foo]\n'))).toContain('tasks.policy.omit lists "foo", not a task field');
    expect(refusals(of('  policy:\n    allow: id\n'))).toContain('tasks.policy.allow must be a list of task fields');
    expect(refusals(of('  policy:\n    allow: [id, title, 3]\n'))).toContain('tasks.policy.allow must be a list of task fields');
    expect(refusals(of('  policy:\n    transform:\n      title: lowercase\n'))).toContain('tasks.policy.transform: only id: bare is defined in this build');
    expect(refusals(of('  policy:\n    transform:\n      id: shout\n'))).toContain('tasks.policy.transform: only id: bare is defined in this build');
    expect(refusals(of('  policy:\n    transform: {}\n'))).toContain('tasks.policy.transform: only id: bare is defined in this build');
    // The record itself: allow must name id and title, omit must name neither.
    expect(refusals(of('  policy:\n    allow: [id]\n'))).toContain('tasks.policy.allow must name id and title, the record itself');
    expect(refusals(of('  policy:\n    allow: [title]\n'))).toContain('tasks.policy.allow must name id and title, the record itself');
    expect(refusals(of('  policy:\n    omit: [id]\n'))).toContain('tasks.policy.omit must not name id or title, the record itself');
    expect(refusals(of('  policy:\n    omit: [title, description]\n'))).toContain('tasks.policy.omit must not name id or title, the record itself');
    // The linear block's own sentences.
    expect(refusals(LINEAR.replace(`    project: ${PROJECT}\n`, ''))).toContain('tasks.linear.project is required');
    expect(refusals(LINEAR.replace('    keychainService: team.linear.acme\n', ''))).toContain('tasks.linear.keychainService is required');
    // The source fence itself.
    expect(refusals(of('  path: .agents/tasks.yaml\n'))).toContain('tasks.path is for source: file');
    expect(refusals(LINEAR.replace('source: linear', 'source: tracker'))).toContain('tasks.source must be file or linear');
  });

  function refusals(text: string): string {
    const checked = validateTeamFile(text);
    if (checked.ok) return '';
    return checked.errors.map((error) => error.message).join('\n');
  }
});

describe('the credential never crosses to the seat', () => {
  test('a full take over the socket: one keychain read, one request, one header, the policy applied', async () => {
    project();
    record();
    let keyReads = 0;
    const world = tracker(issuesAnswer([node({ priority: 1 })]));
    const { running, io, finish } = await startCommand({
      keyReader: async () => {
        keyReads += 1;
        return { ok: true, key: KEY };
      },
      fetch: world.fetch,
    });
    const outcome = await ask(leadSeat, 3000);
    finish();
    expect(await running).toBe(0);
    if (outcome.kind !== 'read' || outcome.read.kind !== 'records') throw new Error(`the read did not arrive: ${JSON.stringify(outcome)}`);
    expect(outcome.read.records).toEqual([{ id: 'ACME-1', title: 'a task', priority: 1 }]);
    expect(keyReads).toBe(1);
    expect(world.requests.length).toBe(1);
    expect(world.requests[0]?.request?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: KEY });
    expect(io.err).toContain('team broker: answering on .agents/broker.sock\n');
    expect(io.err).toContain('team broker: stopped\n');
    expect(existsSync(brokerSocket(root))).toBe(false);
    // The key is in the broker's header and nowhere else this run can see: not the answer, not
    // the terminal, not any file under the clone.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(`${io.out}${io.err}`).not.toContain(KEY);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).not.toContain(KEY);
  });

  test('without the facility the broker refuses to start, forms no request, and binds nothing', async () => {
    project();
    record();
    let fetched = false;
    const world = tracker(issuesAnswer([]));
    const io = testIo(root);
    const code = await runBroker([], io, {
      home,
      keyReader: async () => ({ ok: false, reason: 'the run is not interactive' }),
      fetch: (url, request) => {
        fetched = true;
        return world.fetch(url, request);
      },
    });
    expect(code).toBe(1);
    expect(io.err).toBe('team broker: the run is not interactive\n');
    expect(fetched).toBe(false);
    expect(existsSync(brokerSocket(root))).toBe(false);
  });

  test('the command refuses a file source, a missing source, and a bad invocation', async () => {
    project(FILE_SOURCE);
    record();
    const io = testIo(root);
    expect(await runBroker([], io, { home, keyReader: async () => ({ ok: true, key: KEY }) })).toBe(1);
    expect(io.err).toBe('team broker: tasks.source must be linear; the broker serves a tracker source\n');
    project(LINEAR.replace(/tasks:\n  source: linear\n  linear:\n    project: .*\n    keychainService: .*\n/, ''));
    record();
    const bare = testIo(root);
    expect(await runBroker([], bare, { home, keyReader: async () => ({ ok: true, key: KEY }) })).toBe(1);
    expect(bare.err).toBe('team broker: the team file declares no task source\n');
    const stray = testIo(base);
    expect(await runBroker([], stray, { home })).toBe(2);
    expect(stray.err).toContain('not inside a git repository');
    const extra = testIo(root);
    expect(await runBroker(['extra'], extra, { home })).toBe(2);
    expect(extra.err.startsWith('team broker: unexpected "extra"\nUsage: team broker\n')).toBe(true);
  });

  test('the seat\'s own modules reach no keychain, no network wiring, no child process', () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');
    const client = read('src/broker/client.ts');
    const command = read('src/commands/next.ts');
    const server = read('src/broker/server.ts');
    const reaches = [
      "'node:child_process'",
      "'../release/keychain.ts'",
      "'../release/http.ts'",
      "'../release/checks.ts'",
      "'../tasks/linear.ts'",
    ];
    for (const text of [client, command, server]) {
      for (const specifier of reaches) expect(text).not.toContain(specifier);
    }
    // Only the seat's own two files are held to the no-filesystem rule; the serving half owns
    // the socket file's unlink and reads nothing else.
    for (const text of [client, command]) expect(text).not.toContain("'node:fs'");
    // The serving half checks no credential either: the key lives in the command's own closure.
    expect(server).not.toContain('keychain');
    expect(server).not.toContain('credential');
  });
});
