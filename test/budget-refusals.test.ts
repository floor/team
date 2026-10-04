import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { seatBudget } from '../src/budgets/gate.ts';
import { saveReadings, type Seen } from '../src/budgets/readings.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const now = NOW.getTime();
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;
const IDLE = '❯ \n';
const WHY = 'openai weekly left 5%, changed 1m ago; room: anthropic';

const BASE = `format: 1
project: acme
session: acme
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
    mode: shared
  - role: implementer
    name: worker
    cli: claude-code
    vendor: openai
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

let base: string;
let root: string;
let home: string;

function reading(account: string, left: number, over: Partial<Seen> = {}): Seen {
  return {
    account,
    window: 'weekly',
    left,
    used: 100 - left,
    changedAt: now - 60_000,
    resetsAt: now + 3_600_000,
    seat: account,
    confirmed: true,
    ...over,
  };
}

function store(list: Seen[]): void {
  saveReadings(join(root, '.agents'), 'acme', list, now);
}

function approve(text: string = BASE): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(root);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
  );
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world() {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  const made = {
    launch: {} as Launch,
    labels: [] as string[],
    session: 'absent' as 'absent' | 'running',
  };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.labels.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    sleep: async () => {},
    now: () => NOW,
  };
  return made;
}

async function up(argv: string[], made: ReturnType<typeof world>) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => [],
    home,
    now: () => NOW,
    launch: made.launch,
  };
  const code = await runUp([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err, labels: made.labels };
}

async function add(argv: string[], made: ReturnType<typeof world>) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
  };
  const code = await runAdd([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err, labels: made.labels };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-budget-refusal-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a stored reading refuses one seat', () => {
  test('a confirmed fresh reading inside the reserve refuses, and names who has room', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${WHY}\n`);
    expect(dry.out).toContain('--label lead');
    expect(dry.out).not.toContain('--label worker');
    expect(dry.labels).toEqual([]);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: ${WHY}\n`);
    expect(live.out).toContain('lead: ready\n');
    expect(live.out).not.toContain('worker: ready');
    expect(live.labels).toContain('lead');
    expect(live.labels).not.toContain('worker');
  });

  test('a stale reading with its reset still ahead keeps refusing', async () => {
    store([
      reading('anthropic', 80),
      reading('openai', 5, { changedAt: now - 31 * 60_000 }),
    ]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain('skip worker: would refuse: openai weekly left 5%, changed 31m ago; room: anthropic');
  });

  test('a first sight, an unknown figure, a stale reading with no reset, and an account with no entry do not refuse', async () => {
    store([reading('anthropic', 80), reading('openai', 5, { confirmed: false })]);
    const first = await up(['--dry-run'], world());
    expect(first.out).not.toContain('would refuse');
    expect(first.out).toContain('--label worker');

    store([reading('anthropic', 80)]);
    const unknown = await up(['--dry-run'], world());
    expect(unknown.out).not.toContain('would refuse');
    expect(unknown.out).toContain('openai is unknown; would launch');

    store([
      reading('anthropic', 80),
      reading('openai', 5, { changedAt: now - 31 * 60_000, resetsAt: null }),
    ]);
    const stale = await up(['--dry-run'], world());
    expect(stale.out).not.toContain('would refuse');
    expect(stale.out).toContain('openai is unknown; would launch');

    approve(BASE.replace('    openai: { kind: subscription, reserve: 10%, sources: [status_line] }\n', ''));
    store([reading('anthropic', 80)]);
    const missing = await up(['--dry-run'], world());
    expect(missing.out).not.toContain('would refuse');
    expect(missing.out).not.toContain('is unknown');
    expect(missing.out).toContain('--label worker');
  });

  test('the same reading refuses after a restart, with no seat running', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const made = world();
    expect(made.session).toBe('absent');
    const dry = await up(['--dry-run'], made);
    expect(dry.out).toContain(`skip worker: would refuse: ${WHY}`);
    expect(dry.labels).toEqual([]);
  });

  test('an unknown account is said, and the seat still starts', async () => {
    store([reading('anthropic', 80)]);
    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.out).toContain('worker: openai is unknown\n');
    expect(live.out).toContain('worker: ready\n');
    expect(live.labels).toContain('worker');
  });

  test('the tighter window is the one named', () => {
    approve();
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error('file');
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('worker');
    const decision = seatBudget(loaded.team, [
      reading('openai', 40),
      reading('openai', 5, { window: 'session' }),
      reading('anthropic', 80),
    ], worker, now);
    expect(decision).toEqual({ kind: 'refuse', why: 'openai session left 5%, changed 1m ago; room: anthropic' });
  });

  test('a spend account is unknown until a money reading exists', () => {
    const text = BASE.replace(
      'openai: { kind: subscription, reserve: 10%, sources: [status_line] }',
      'openai: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }',
    );
    approve(text);
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('worker');
    expect(seatBudget(loaded.team, [], worker, now)).toEqual({ kind: 'unknown', account: 'openai' });
  });
});

describe('team add', () => {
  test('refuses the seat before launching it, and --dry-run shows that', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const refused = await add(['worker'], world());
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`team add: ${WHY}\n`);
    expect(refused.labels).toEqual([]);

    const dry = await add(['worker', '--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`worker: would refuse: ${WHY}\n`);
    expect(dry.out).toContain('dry run: nothing was run\n');
    expect(dry.labels).toEqual([]);
  });
});
