import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedFingerprints } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { DEADLINE, NOT_RUNNING, WRONG_ANSWER } from '../src/broker/client.ts';
import { brokerSocket } from '../src/broker/protocol.ts';
import { startBroker, type BrokerReadResult } from '../src/broker/server.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { main } from '../src/cli.ts';
import { runBroker } from '../src/commands/broker.ts';
import { runIssues } from '../src/commands/issues.ts';
import { runNext, type NextSources } from '../src/commands/next.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Fetch } from '../src/release/http.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { TaskAdapter } from '../src/tasks/adapter.ts';
import { LEASE_MS } from '../src/tasks/lease.ts';
import { newMemory, pass, RING_TEXT } from '../src/watch/pass.ts';
import { gitEnv, testIo } from './helpers.ts';

const TEAM = `format: 1
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
`;

const BOTH = `format: 1
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
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const WITH = `${TEAM}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const WITH_BOTH = `${BOTH}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' };
const otherPane: Caller = { kind: 'seat', name: 'lead', pane: 'w9:p1', session: 'acme' };

let base: string;
let root: string;
let home: string;
let now = Date.parse('2026-10-08T09:00:00.000Z');

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function project(text = WITH): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-next-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  now = Date.parse('2026-10-08T09:00:00.000Z');
}

function list(text: string): void {
  writeFileSync(join(root, '.agents', 'tasks.yaml'), text);
}

function record(): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function ready(text = WITH, tasks: string | null = '- id: m1\n  title: the task title\n'): void {
  project(text);
  if (tasks !== null) list(tasks);
  record();
}

async function run(
  argv: string[] = [],
  caller: Caller = lead,
  registry?: Record<string, TaskAdapter>,
  cwd = root,
) {
  const io = testIo(cwd, caller);
  const code = await runNext(argv, io, { home, now: () => now, ...(registry ? { registry } : {}) });
  return { code, out: io.out, err: io.err };
}

function lease(id = 'm1'): { format: number; id: string; seat: string; pane: string; acquiredAt: string; renewedAt: string; until: string } {
  return JSON.parse(readFileSync(join(root, '.agents', 'leases', `${id}.json`), 'utf8'));
}

function leaseNames(): string[] {
  const dir = join(root, '.agents', 'leases');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  });
}

describe('team next', () => {
  test('a placed seat claims the record and the lease names that seat and pane', async () => {
    ready();
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    expect(lease()).toMatchObject({ format: 1, id: 'm1', seat: 'lead', pane: 'w1:p1' });
    const listed = testIo(root);
    expect(await runIssues([], listed, { home })).toBe(0);
    expect(listed.out).toBe('m1  the task title\n');
  });

  test('team plan stays an unknown command', async () => {
    ready();
    const plan = testIo(root);
    expect(await main(['plan'], plan)).toBe(2);
    expect(plan.err.startsWith('team: unknown command "plan"\n')).toBe(true);
  });

  test('pull and fallback validate, and an omitted key stays off the parsed section', () => {
    expect(validateTeamFile(WITH).ok).toBe(true);
    expect(validateTeamFile(`${WITH}  pull: any\n  fallback: id\n`).ok).toBe(true);
    expect(validateTeamFile(`${WITH}  fallback: file\n`).ok).toBe(true);
    for (const [key, sentence] of [
      ['fallback: rank', 'tasks.fallback must be file or id'],
      ['pull: open', 'tasks.pull must be self or any'],
    ] as const) {
      const checked = validateTeamFile(`${WITH}  ${key}\n`);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.errors.map((error) => error.message)).toContain(sentence);
    }
    const plain = validateTeamFile(WITH);
    const pulled = validateTeamFile(`${WITH}  pull: any\n`);
    if (!plain.ok || !pulled.ok) throw new Error('the fixtures do not validate');
    expect(plain.team.tasks).toEqual({ source: 'file', path: '.agents/tasks.yaml' });
    expect(pulled.team.tasks).toEqual({ source: 'file', path: '.agents/tasks.yaml', pull: 'any' });
    const stored = fingerprints(plain.team);
    const again = approvedFingerprints({ approval: { fingerprints: stored }, file: WITH } as never);
    expect(again.sections.tasks).toBe(fingerprints(plain.team).sections.tasks);
    const drifted = approvedFingerprints({ approval: { fingerprints: stored }, file: `${WITH}  pull: any\n` } as never);
    expect(drifted.sections.tasks).not.toBe(fingerprints(pulled.team).sections.tasks);
  });

  test('two seats in one clone leave one lease file', async () => {
    ready(WITH_BOTH);
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    expect(await run([], worker)).toEqual({ code: 0, out: 'team next: nothing is takeable\n', err: '' });
    expect(leaseNames()).toEqual(['m1.json']);
    expect(lease().seat).toBe('lead');
  });

  test('a linked worktree writes the lease in the main checkout', async () => {
    ready(WITH_BOTH);
    writeFileSync(join(root, 'README.md'), 'acme\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'first');
    const worktree = join(base, 'wt');
    git(root, 'worktree', 'add', '-q', worktree, '-b', 'task');
    expect(await run([], lead, undefined, worktree)).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    expect(existsSync(join(root, '.agents', 'leases', 'm1.json'))).toBe(true);
    expect(existsSync(join(worktree, '.agents', 'leases', 'm1.json'))).toBe(false);
    expect(await run([], worker)).toEqual({ code: 0, out: 'team next: nothing is takeable\n', err: '' });
  });

  test('another seat is not taken unless the file says so, and --mine does not widen', async () => {
    ready(WITH, '- id: m1\n  title: the task title\n  assignee: other\n');
    expect(await run()).toEqual({ code: 0, out: 'team next: nothing is takeable\n', err: '' });
    expect(leaseNames()).toEqual([]);
    project(`${WITH}  pull: any\n`);
    list('- id: m1\n  title: the task title\n  assignee: other\n');
    record();
    expect(await run(['--mine'])).toEqual({ code: 0, out: 'team next: nothing is assigned to you\n', err: '' });
    expect(leaseNames()).toEqual([]);
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n  assignee: other\n', err: '' });
    expect(lease().seat).toBe('lead');
  });

  test('a number is taken before a string, and a record with no priority is last', async () => {
    ready(WITH, '- id: m0\n  title: plain\n- id: m2\n  title: numbered\n  priority: 2\n- id: m1\n  title: labeled\n  priority: "1"\n');
    expect((await run()).out).toBe('m2  numbered\n  priority: 2\n');
    expect(await run(['--release'])).toEqual({ code: 0, out: 'team next: released m2\n', err: '' });
    // Release records no progress, so the number is back at the head of the queue.
    expect((await run()).out).toBe('m2  numbered\n  priority: 2\n');
    ready(WITH_BOTH, '- id: m0\n  title: plain\n- id: m1\n  title: labeled\n  priority: "1"\n');
    expect((await run()).out).toBe('m1  labeled\n  priority: 1\n');
    expect((await run([], worker)).out).toBe('m0  plain\n');
  });

  test('fallback id orders only the records that have no priority', async () => {
    ready(`${WITH}  fallback: id\n`, '- id: b\n  title: second\n- id: a\n  title: first\n');
    expect((await run()).out).toBe('a  first\n');
    ready(`${WITH}  fallback: id\n`, '- id: b\n  title: plain\n- id: a\n  title: numbered\n  priority: 1\n');
    expect((await run()).out).toBe('a  numbered\n  priority: 1\n');
    ready(WITH, '- id: b\n  title: second\n- id: a\n  title: first\n');
    expect((await run()).out).toBe('b  second\n');
  });

  test('a non-empty blocked-by, repos, or needs is not taken, and an empty list is', async () => {
    ready(WITH, '- id: m1\n  title: the task title\n  blocked-by: [m0]\n');
    expect(await run()).toEqual({ code: 0, out: 'team next: nothing is takeable\n', err: '' });
    expect(leaseNames()).toEqual([]);
    const listed = testIo(root);
    expect(await runIssues([], listed, { home })).toBe(0);
    expect(listed.out).toContain('blocked-by: m0');
    list('- id: m1\n  title: the task title\n  blocked-by: []\n');
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });

    ready(WITH, '- id: m1\n  title: the task title\n  repos: [other]\n- id: m2\n  title: another title\n  needs: [review]\n');
    expect(await run()).toEqual({ code: 0, out: 'team next: nothing is takeable\n', err: '' });
    const shown = testIo(root);
    expect(await runIssues([], shown, { home })).toBe(0);
    expect(shown.out).toContain('repos: other');
    expect(shown.out).toContain('needs: review');
  });

  test('an expired lease can be taken, a live one renews, and release frees the next id', async () => {
    ready(WITH_BOTH, '- id: m1\n  title: the task title\n- id: m2\n  title: another title\n');
    expect((await run()).out).toBe('m1  the task title\n');
    const first = lease();
    now += 1000;
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    const renewed = lease();
    expect(renewed.acquiredAt).toBe(first.acquiredAt);
    expect(Date.parse(renewed.until)).toBe(Date.parse(first.until) + 1000);
    expect(leaseNames()).toEqual(['m1.json']);
    now += LEASE_MS;
    expect(await run([], worker)).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    expect(lease().seat).toBe('worker');
    expect(await run(['--release'], worker)).toEqual({ code: 0, out: 'team next: released m1\n', err: '' });
    expect(leaseNames()).toEqual([]);
    expect((await run()).out).toBe('m1  the task title\n');
    expect((await run([], worker)).out).toBe('m2  another title\n');
  });

  test('a repeated id is refused and renewal reprints the first record', async () => {
    const block = 'm1  first version\n';
    const repeat = 'team next: m1 is not a task: its id repeats an earlier record\n';
    ready(WITH, '- id: m1\n  title: first version\n- id: m1\n  title: second version\n');
    expect(await run()).toEqual({ code: 0, out: block, err: repeat });
    const first = lease();
    expect(leaseNames()).toEqual(['m1.json']);
    now += 1000;
    expect(await run()).toEqual({ code: 0, out: block, err: repeat });
    const renewed = lease();
    expect(leaseNames()).toEqual(['m1.json']);
    expect(renewed.acquiredAt).toBe(first.acquiredAt);
    expect(renewed.id).toBe(first.id);
    expect(Date.parse(renewed.until)).toBe(Date.parse(first.until) + 1000);
    const listed = testIo(root);
    expect(await runIssues([], listed, { home })).toBe(1);
    expect(listed.out).toBe(block);
    expect(listed.err).toBe('team issues: m1 is not a task: its id repeats an earlier record\n');
    expect(await run(['--release'])).toEqual({ code: 0, out: 'team next: released m1\n', err: '' });
    expect(leaseNames()).toEqual([]);
    expect(await run()).toEqual({ code: 0, out: block, err: repeat });
    ready(WITH, '- id: m1\n  title: first version\n- id: m1\n');
    expect(await run()).toEqual({
      code: 0,
      out: block,
      err: 'team next: m1 is not a task: title is required\n',
    });
    ready(WITH, '- id: m1\n- id: m1\n  title: second version\n');
    expect(await run()).toEqual({
      code: 0,
      out: 'm1  second version\n',
      err: 'team next: m1 is not a task: title is required\n',
    });
  });

  test('a bad record does not block a good one', async () => {
    ready(WITH, '- id: m1\n- id: m2\n  title: another title\n');
    expect(await run()).toEqual({
      code: 0,
      out: 'm2  another title\n',
      err: 'team next: m1 is not a task: title is required\n',
    });
    ready(WITH, '- id: m1\n');
    expect(await run()).toEqual({ code: 1, out: '', err: 'team next: m1 is not a task: title is required\n' });
    list('id: m1\n');
    expect(await run()).toEqual({ code: 1, out: '', err: 'team next: the task file is not a list\n' });
  });

  test('file failures keep the issues sentences and do not read the task file', async () => {
    let read = false;
    const registry: Record<string, TaskAdapter> = {
      file: {
        name: 'file',
        read: () => {
          read = true;
          return { kind: 'missing' };
        },
      },
    };
    ready(TEAM, null);
    expect(await run([], lead, registry)).toEqual({ code: 1, out: '', err: 'team next: the team file declares no task source\n' });
    expect(read).toBe(false);
    ready(WITH, null);
    expect(await run()).toEqual({ code: 1, out: '', err: 'team next: the task file is not there\n' });
    read = false;
    project(`${TEAM}tasks:\n  source: file\n  path: ../outside.yaml\n`);
    list('- id: m1\n  title: the task title\n');
    record();
    expect(await run([], lead, registry)).toEqual({ code: 1, out: '', err: 'team next: tasks.path must stay inside the checkout\n' });
    expect(read).toBe(false);
    ready(WITH);
    expect(await run([], lead, {})).toEqual({ code: 1, out: '', err: 'team next: tasks.source must be file\n' });
  });

  test('a stub claim prints the record and writes no local lease', async () => {
    ready();
    const stub: TaskAdapter = {
      name: 'file',
      read: () => ({ kind: 'records', records: [{ id: 's1', title: 'from the stub' }, { id: 's2', title: 'later' }], refusals: [] }),
      claim: (input) => (input.record.id === 's1' ? { kind: 'busy' } : { kind: 'held' }),
      release: () => ({ kind: 'released', id: 's2' }),
    };
    expect(await run([], lead, { file: stub })).toEqual({ code: 0, out: 's2  later\n', err: '' });
    expect(leaseNames()).toEqual([]);
    expect(await run(['--release'], lead, { file: stub })).toEqual({ code: 0, out: 'team next: released s2\n', err: '' });
    expect(leaseNames()).toEqual([]);
  });

  test('the caller is a seat on its recorded pane', async () => {
    ready();
    expect(await run([], { kind: 'owner' })).toEqual({
      code: 1,
      out: '',
      err: 'team next: only a seat of this team pulls a task; this call is owner\n',
    });
    expect(leaseNames()).toEqual([]);
    expect(await run([], { kind: 'seat', name: 'stranger', pane: 'w1:p1', session: 'acme' })).toEqual({
      code: 1,
      out: '',
      err: 'team next: only a seat of this team pulls a task; this call is stranger\n',
    });
    project(WITH);
    list('- id: m1\n  title: the task title\n');
    expect(await run()).toEqual({ code: 1, out: '', err: `team next: ${noPaneRefusal('lead')}\n` });
    record();
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'w2:p1' };
    });
    expect(await run([], otherPane)).toEqual({
      code: 1,
      out: '',
      err: `team next: ${anotherPaneRefusal('lead', 'w2:p1')}\n`,
    });
  });

  test('the same seat name on another pane does not renew or steal', async () => {
    ready(WITH, '- id: m1\n  title: the task title\n- id: m2\n  title: another title\n');
    expect((await run()).out).toBe('m1  the task title\n');
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'w9:p1' };
    });
    expect(await run([], otherPane)).toEqual({ code: 0, out: 'm2  another title\n', err: '' });
    expect(lease('m1')).toMatchObject({ seat: 'lead', pane: 'w1:p1' });
    expect(lease('m2')).toMatchObject({ seat: 'lead', pane: 'w9:p1' });
  });

  test('a file that is not the lease JSON can be replaced by one caller', async () => {
    ready();
    mkdirSync(join(root, '.agents', 'leases'));
    writeFileSync(join(root, '.agents', 'leases', 'm1.json'), 'not json\n');
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    expect(lease().seat).toBe('lead');
  });

  test('--mine and --release together write nothing, and a stray argument prints the usage', async () => {
    ready();
    expect(await run(['--mine', '--release'])).toEqual({
      code: 2,
      out: '',
      err: 'team next: --mine and --release are not used together\n',
    });
    expect(leaseNames()).toEqual([]);
    expect(await run(['extra'])).toEqual({
      code: 2,
      out: '',
      err: 'team next: unexpected "extra"\nUsage: team next [--mine | --release]\n',
    });
    const io = testIo(base, lead);
    expect(await runNext([], io, { home, now: () => now })).toBe(2);
    expect(io.err).toContain('not inside a git repository');
  });

  test('a release of nothing, and of another seat, leaves that seat\'s file', async () => {
    ready(WITH_BOTH);
    expect(await run(['--release'])).toEqual({ code: 0, out: 'team next: nothing is held\n', err: '' });
    expect((await run()).out).toBe('m1  the task title\n');
    expect(await run(['--release'], worker)).toEqual({ code: 0, out: 'team next: nothing is held\n', err: '' });
    expect(lease().seat).toBe('lead');
  });

  test('the ring and the key stay put, and the issues page no longer says team next is not a command', async () => {
    ready();
    expect((await run()).code).toBe(0);
    expect(existsSync(join(home, '.config', 'team-key'))).toBe(false);
    expect(RING_TEXT).toBe('Team: run team messages');
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the fixture does not validate');
    const result = pass({
      team: checked.team,
      state: emptySession(),
      live: { running: false, agents: [], workspaces: [], screens: {} },
      machine: { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null },
      now,
      memory: newMemory(),
      watch: checked.team.watch,
      mailbox: [],
    });
    expect(result.ring).toBeNull();
    expect(JSON.stringify(result)).not.toContain('team next');
    const page = readFileSync(join(import.meta.dir, '..', 'docs', 'commands', 'issues.md'), 'utf8');
    expect(page).not.toContain('`team next` and `team plan` are not commands.');
    expect(page).toContain('`team plan` is not a command.');
  });
});

describe('team next over the broker', () => {
  const PROJECT_ID = '01234567-89ab-cdef-0123-456789abcdef';
  const KEY = 'test-key-not-real';

  const LINEAR = `${TEAM}tasks:
  source: linear
  linear:
    project: ${PROJECT_ID}
    keychainService: team.linear.acme
`;
  const LINEAR_POLICY = `${LINEAR}  policy:
    omit: [priority]
`;
  const WORKER_ONLY_LINEAR = `format: 1
project: acme
coordinator: worker
operator: worker
workspace:
  mode: shared
seats:
  - role: coordinator
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
tasks:
  source: linear
  linear:
    project: ${PROJECT_ID}
    keychainService: team.linear.acme
`;

  function teamFrom(text: string) {
    const checked = validateTeamFile(text);
    if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
    return checked.team;
  }

  /** The answer map, the release world's shape: no test here opens a connection. */
  function world(nodes: unknown[]): { fetch: Fetch; requests: number[] } {
    const requests: number[] = [];
    const value = { data: { project: { id: PROJECT_ID, issues: { nodes, pageInfo: { hasNextPage: false } } } } };
    const fetch: Fetch = (url, request) => {
      requests.push(0);
      return Promise.resolve({ kind: 'http', status: 200, body: JSON.stringify(value) });
    };
    return { fetch, requests };
  }

  function brokerNode(change: Record<string, unknown> = {}): Record<string, unknown> {
    return { identifier: 'm1', title: 'the task title', ...change };
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let tries = 0; tries < 200; tries++) {
      if (check()) return;
      await new Promise((tick) => setTimeout(tick, 10));
    }
    throw new Error('the condition never held');
  }

  /** The broker command in-process: the keychain and the tracker are seams, the stop is held. */
  async function command(fetch: Fetch): Promise<{ running: Promise<number>; finish: () => void; err: string; reads: () => number }> {
    const io = testIo(root);
    let finish!: () => void;
    let reads = 0;
    const running = runBroker([], io, {
      home,
      keyReader: async () => {
        reads += 1;
        return { ok: true, key: KEY };
      },
      fetch,
      stop: (end) => {
        finish = end;
        return () => {};
      },
    });
    await waitFor(() => io.err.includes('answering on'));
    return { running, finish, err: io.err, reads: () => reads };
  }

  /** A plain listener on the clone's socket path, closed with its connections (bun's node:net
   *  server has no `closeAllConnections`). */
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

  /** A broker serving one reader, for the refusals the command maps to its exits. */
  async function serve(read: () => Promise<BrokerReadResult>, text = LINEAR): Promise<() => Promise<void>> {
    const started = await startBroker({ root, team: teamFrom(text), read, stderr: () => {} });
    if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
    return () => started.handle.close();
  }

  async function runWith(sources: NextSources) {
    const io = testIo(root, lead);
    const code = await runNext([], io, { home, now: () => now, ...sources });
    return { code, out: io.out, err: io.err };
  }

  test('with no broker running the take refuses and claims nothing', async () => {
    ready(LINEAR);
    expect(await run()).toEqual({ code: 1, out: '', err: `team next: ${NOT_RUNNING}\n` });
    expect(leaseNames()).toEqual([]);
  });

  test('a served read prints the record, applies the file policy, and takes the local lease', async () => {
    ready(LINEAR_POLICY);
    const tracker = world([brokerNode({ priority: 1 })]);
    const broker = await command(tracker.fetch);
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    expect(lease()).toMatchObject({ id: 'm1', seat: 'lead', pane: 'w1:p1' });
    expect(tracker.requests.length).toBe(1);
    expect(broker.reads()).toBe(1);
    broker.finish();
    expect(await broker.running).toBe(0);
    // The lease is local: --release works with the broker gone, and claims nothing from it.
    expect(await run(['--release'])).toEqual({ code: 0, out: 'team next: released m1\n', err: '' });
    expect(leaseNames()).toEqual([]);
  });

  test('an answer this build does not know, and a broker that never answers, both claim nothing', async () => {
    ready(LINEAR);
    const garbage = await rawServer((socket) => socket.end('not json\n'));
    try {
      expect(await run()).toEqual({ code: 1, out: '', err: `team next: ${WRONG_ANSWER}\n` });
    } finally {
      await garbage();
    }
    const silent = await rawServer(() => {});
    try {
      expect(await runWith({ deadlineMs: 200 })).toEqual({ code: 1, out: '', err: `team next: ${DEADLINE}\n` });
    } finally {
      await silent();
    }
    expect(leaseNames()).toEqual([]);
  });

  test('a failed read is the seat\'s read refusal, and a stale team is the caller\'s', async () => {
    ready(LINEAR);
    const failing = await serve(() => Promise.resolve({ kind: 'failed', message: 'the tracker could not be read' }));
    try {
      expect(await run()).toEqual({ code: 1, out: '', err: 'team next: the broker failed this read\n' });
    } finally {
      await failing();
    }
    // A broker left over from another team: its request check refuses the caller, and the seat
    // maps that to its own caller exit — the answer says which side refused.
    const stale = await serve(() => Promise.resolve({ kind: 'read', read: { kind: 'records', records: [], refusals: [] } }), WORKER_ONLY_LINEAR);
    try {
      expect(await run()).toEqual({ code: 1, out: '', err: 'team next: only a seat of this team pulls a task; this request names lead\n' });
    } finally {
      await stale();
    }
    expect(leaseNames()).toEqual([]);
  });

  test('a policy the validator refuses is the file refusal, before any broker is asked', async () => {
    ready(`${LINEAR}  policy:
    omit: [title]
`);
    expect(await run()).toEqual({ code: 1, out: '', err: 'team next: tasks.policy.omit must not name id or title, the record itself\n' });
    expect(leaseNames()).toEqual([]);
  });
});
