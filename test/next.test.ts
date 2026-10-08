import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedFingerprints } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { main } from '../src/cli.ts';
import { runIssues } from '../src/commands/issues.ts';
import { runNext } from '../src/commands/next.ts';
import { validateTeamFile } from '../src/file/validate.ts';
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
