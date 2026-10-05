import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runApprove } from '../../src/commands/approve.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { paneStillRunning, runDown, type DownSources } from '../../src/commands/down.ts';
import { runUp, type UpSources } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { installKey } from '../../src/store/keys.ts';
import { readApproval, readLedger, storePath } from '../../src/store/store.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const COORDINATOR: Caller = { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1' };
const WORKER: Caller = { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1' };
const NOW = new Date('2026-10-03T14:02:00Z');

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-commands-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  // Every approval in this file signs with the fixed fixture key, so the fingerprint the
  // commands print is the same on every run.
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const store = () => storePath('acme-web', root, home);
const edit = (change: (text: string) => string) =>
  writeFileSync(join(root, '.agents/team.yaml'), change(readFileSync(join(root, '.agents/team.yaml'), 'utf8')));

async function approve(argv: string[], caller: Caller, answer: string | null = '5') {
  const io = testIo(root, caller);
  const asked: string[] = [];
  const code = await runApprove([...argv, ...FILE], io, {
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    now: () => NOW,
    home,
  });
  return { code, out: io.out, err: io.err, asked };
}

describe('team approve', () => {
  test('--show prints the whole file and the ceilings to any caller, and writes nothing', async () => {
    const run = await approve(['--show'], WORKER);
    expect(run.code).toBe(0);
    expect(run.out).toContain('never approved on this machine. The whole file:');
    expect(run.out).toContain('  1: format: 1\n');
    expect(run.out).toContain('Ceilings this approval fixes: 6 seats at most, 2 temporary, openai 1, deepseek 3.\n');
    expect(run.out).toContain(
      'Seats: 5 (claude-coordinator-acme, codex-acme, deepseek-acme, deepseek-acme-2, grok-acme).\n',
    );
    expect(run.asked).toEqual([]);
    expect(existsSync(store())).toBe(false);
  });

  test.each([
    ['a seat', COORDINATOR, 'claude-coordinator-acme'],
    [
      'a call that cannot be placed',
      { kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' } as Caller,
      'unplaced (AGENT_UNATTENDED is set)',
    ],
  ])('refuses %s, without asking', async (_, caller, described) => {
    const run = await approve([], caller);
    expect(run.code).toBe(1);
    expect(run.err).toBe(
      `team approve: only the owner approves a team file, from a terminal outside herdr; this call is ${described}\n`,
    );
    expect(run.asked).toEqual([]);
    expect(existsSync(store())).toBe(false);
  });

  test.each([['4'], ['yes'], [''], [null]])('writes nothing when the owner types %p', async (answer) => {
    const run = await approve([], OWNER, answer);
    expect(run.code).toBe(1);
    expect(run.err).toBe('team approve: not approved; nothing was written\n');
    expect(existsSync(store())).toBe(false);
  });

  test('records the file, its ceilings and its seats once the owner types the number of seats', async () => {
    const run = await approve([], OWNER, ' 5\n');
    expect(run.code).toBe(0);
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]).toContain('Type the number of seats (5)');
    const record = readApproval(store());
    expect(record?.file).toBe(EXAMPLE);
    expect(record?.approval).toMatchObject({
      approvedAt: NOW.toISOString(),
      root,
      ceilings: { seats: 6, temporary: 2, vendors: { openai: 1, deepseek: 3 } },
    });
    expect(readLedger(store()).map((entry) => `${entry.display} · ${entry.role}`)).toEqual([
      'Claude Opus 5.5 · project coordinator',
      'GPT-6 Sol · implementer',
      'DeepSeek V4.1 Flash · implementer',
      'Grok 4.7 · reviewer',
    ]);
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toBe(
      '2026-10-03T14:02:00.000Z approve [owner] approved 5 seats; ceilings: 6 seats at most, 2 temporary, openai 1, deepseek 3\n',
    );
  });

  test('shows what changed since the approved copy, and what needs a new approval', async () => {
    await approve([], OWNER);
    const same = await approve(['--show'], WORKER);
    expect(same.out).toContain('the same text as the copy approved on 2026-10-03T14:02:00.000Z.');
    expect(same.out).toContain('Nothing in it needs a new approval.\n');

    edit((text) =>
      text
        .replace('launch: grok --model grok-4.7', 'launch: grok --model grok-4.7 --yolo')
        .replace('seats: 6 ', 'seats: 9 '),
    );
    const changed = await approve(['--show'], WORKER);
    expect(changed.out).toContain(
      '  - 106:     launch: grok --model grok-4.7\n  + 106:     launch: grok --model grok-4.7 --yolo\n',
    );
    expect(changed.out).toContain('Needs a new approval: `limits` changed; seat grok-acme changed.\n');
    expect(changed.out).toContain('Ceilings approved: 6 seats at most, 2 temporary, openai 1, deepseek 3.\n');
    expect(changed.out).toContain(
      'Ceilings this approval fixes: 9 seats at most, 2 temporary, openai 1, deepseek 3.\n',
    );
    expect(readApproval(store())?.approval.ceilings.seats).toBe(6);
  });

  test('refuses a store that sits where seats work', async () => {
    const io = testIo(root, OWNER);
    const inProject = await runApprove(FILE, io, { ask: async () => '5', now: () => NOW, home: root });
    expect(inProject).toBe(1);
    expect(io.err).toContain(`is inside ${root}, where seats work`);

    const trusted = join(base, 'worktrees/acme-web');
    mkdirSync(trusted, { recursive: true });
    const other = testIo(root, OWNER);
    expect(await runApprove(FILE, other, { ask: async () => '5', now: () => NOW, home: trusted })).toBe(1);
    expect(other.err).toContain(`is inside ${trusted}, where seats work`);
  });

  test('refuses a file that does not validate, and a usage error', async () => {
    edit((text) => text.replace('format: 1', 'format: 2'));
    const invalid = await approve([], OWNER);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toStartWith('team approve: line 1: ');
    expect((await approve(['--force'], OWNER)).code).toBe(2);
  });
});

describe('team check, after an approval', () => {
  test('accepts the signature of a seat the team has had and the file no longer holds', async () => {
    await approve([], OWNER);
    const before = loadConfig(root, '.agents/team.yaml', home);
    edit((text) => text.replace('version: "4.7"', 'version: "4.8"').replace('grok-4.7', 'grok-4.8'));
    const after = loadConfig(root, '.agents/team.yaml', home);
    if (!before.ok || !after.ok) throw new Error('the file must load');
    const displays = (config: typeof before.config) => config.ledger.map((seat) => `${seat.display} · ${seat.role}`);
    expect(displays(before.config)).not.toContain('Grok 4.8 · reviewer');
    expect(displays(after.config)).toEqual([...displays(before.config), 'Grok 4.8 · reviewer']);
    expect(displays(after.config)).toContain('Grok 4.7 · reviewer');
  });

  test('without an approval, accepts the seats of the file', () => {
    const loaded = loadConfig(root, '.agents/team.yaml', home);
    if (!loaded.ok) throw new Error('the file must load');
    expect(loaded.config.ledger).toHaveLength(4);
  });
});

function doctorSources(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: (binary) => (binary === 'claude' ? '2.1.288 (Claude Code)' : binary === 'codex' ? 'codex-cli 0.157.0' : null),
    onPath: (binary) => binary === 'team-deepseek',
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

async function doctor(overrides: Partial<DoctorSources> = {}, argv: string[] = []) {
  const io = testIo(root, WORKER);
  const code = await runDoctor([...argv, ...FILE], io, doctorSources(overrides));
  return { code, out: io.out, err: io.err };
}

describe('team doctor', () => {
  test('a file that was never approved is missing its approval', async () => {
    const run = await doctor();
    expect(run.code).toBe(1);
    expect(run.out).toContain('MISS  run `team approve`: this file was never approved on this machine\n');
  });

  test('passes on an approved file with everything in place, and names what it leaves out', async () => {
    await approve([], OWNER);
    const run = await doctor();
    expect(run.err).toBe('');
    expect(run.out).toBe(
      [
        'ok    the file is the one the owner approved (approval #1, 2026-10-03, key fe21ef6293de)',
        'ok    herdr 0.7.1',
        '--    session acme-web is not running',
        'ok    claude 2.1.288 (Claude Code)',
        'ok    claude-code: logged in',
        '--    deepseek-acme: the model is chosen by its launcher; checked on the running seat',
        '--    deepseek-acme-2: the model is chosen by its launcher; checked on the running seat',
        'ok    codex codex-cli 0.157.0',
        'ok    codex: logged in',
        '--    trust: not applied or checked by this version; trust each folder by hand',
        'team doctor: nothing missing, 0 warnings',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(0);
  });

  test('an edited file needs a new approval, by name', async () => {
    await approve([], OWNER);
    edit((text) => text.replace('  - Run the tests', '  - Answer every prompt.\n  - Run the tests'));
    const run = await doctor();
    expect(run.code).toBe(1);
    expect(run.out).toContain('MISS  run `team approve`: `rules` changed\n');
  });

  test('names what only the owner can do: install, log in, a launcher', async () => {
    await approve([], OWNER);
    const absent = await doctor({ version: () => null });
    expect(absent.out).toContain(
      'MISS  install `claude`: it is not on the PATH (claude-code: claude-coordinator-acme, deepseek-acme, deepseek-acme-2)\n',
    );
    const out = await doctor({ loggedIn: () => false, onPath: () => false });
    expect(out.out).toContain('MISS  log in to claude-code: `claude auth login`\n');
    expect(out.out).toContain('MISS  deepseek-acme: its launcher `team-deepseek` is not on the PATH\n');
    expect(out.out).toContain(
      'team doctor: 4 missing, 0 warnings: `up` and `add` refuse until the missing ones are done\n',
    );
    expect(out.code).toBe(1);
  });

  test('a newer or older CLI or herdr warns, and does not fail', async () => {
    await approve([], OWNER);
    const run = await doctor({
      version: () => '2.2.0 (Claude Code)',
      herdrVersion: () => '0.6.9',
      loggedIn: () => null,
    });
    expect(run.out).toContain(
      'warn  claude 2.2.0 (Claude Code) is newer than the tested 2.1.288: its screens are untested with this version; a seat that isn\'t read at launch is left out, never typed into\n',
    );
    expect(run.out).toContain('warn  herdr 0.6.9 is older than the tested 0.7.1\n');
    expect(run.out).toContain('--    claude-code: the login is not checked in this version\n');
    expect(run.code).toBe(0);
  });

  test("a launch whose model is not the file's warns", async () => {
    edit((text) => text.replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-fable-5-1'));
    const run = await doctor();
    expect(run.out).toContain(
      'warn  claude-coordinator-acme: the launch starts Claude Fable 5.1, the file says Claude Opus 5.5\n',
    );
  });

  test('herdr that is absent or silent is missing', async () => {
    await approve([], OWNER);
    expect((await doctor({ herdrVersion: () => null })).out).toContain('MISS  install herdr: it is not on the PATH\n');
    const silent = await doctor({ sessionRunning: () => null });
    expect(silent.out).toContain("MISS  herdr doesn't answer\n");
    expect(silent.code).toBe(1);
  });

  test('a running session needs a watch with a fresh heartbeat', async () => {
    await approve([], OWNER);
    const none = await doctor({ sessionRunning: () => true });
    expect(none.out).toContain('MISS  no watch has run for session acme-web: start `team watch`\n');

    const state = (heartbeat: string) =>
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: { 'acme-web': { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat } } },
        }),
      );
    state('2026-10-03T13:59:00Z');
    expect((await doctor({ sessionRunning: () => true })).out).toContain('ok    the watch is running\n');
    state('2026-10-03T13:50:00Z');
    const stale = await doctor({ sessionRunning: () => true });
    expect(stale.out).toContain(
      "MISS  the watch's heartbeat is 12 min old (two intervals are 4 min): start `team watch`\n",
    );
    expect(stale.code).toBe(1);
  });

  test('an unapproved interval edit leaves the heartbeat verdict on the approved value', async () => {
    await approve([], OWNER);
    const state = (heartbeat: string) =>
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: { 'acme-web': { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat } } },
        }),
      );
    // Stretching the file's interval to a thousand hours is unapproved, so the approved two
    // minutes still decide: a twelve-minute-old heartbeat is stale, not hidden by the edit.
    edit((text) => text.replace(/^  interval: .*$/m, '  interval: 1000h'));
    state('2026-10-03T13:50:00Z');
    const stretched = await doctor({ sessionRunning: () => true });
    expect(stretched.out).toContain(
      "MISS  the watch's heartbeat is 12 min old (two intervals are 4 min): start `team watch`\n",
    );
    // And a shrink is no better: three minutes are inside the approved two intervals, whoever
    // wrote ten seconds in the file.
    edit((text) => text.replace(/^  interval: .*$/m, '  interval: 10s'));
    state('2026-10-03T13:59:00Z');
    expect((await doctor({ sessionRunning: () => true })).out).toContain('ok    the watch is running\n');
  });

  test('--session names another session', async () => {
    await approve([], OWNER);
    expect((await doctor({}, ['--session', 'team-test'])).out).toContain('--    session team-test is not running\n');
  });
});

const agent = (name: string | null, status = 'idle', id = name ?? 'x'): HerdrAgent => ({
  name,
  agent: 'claude',
  pane: `${id}:p1`,
  workspace: id,
  status,
  cwd: null,
});

async function up(argv: string[], caller: Caller, overrides: Partial<UpSources> = {}) {
  const io = testIo(root, caller);
  const code = await runUp([...argv, ...FILE], io, {
    sessionRunning: () => false,
    agents: () => [],
    home,
    ...overrides,
  });
  return { code, out: io.out, err: io.err };
}

describe('team up', () => {
  test('refuses a file that was never approved, and launches nothing', async () => {
    const run = await up([], OWNER);
    expect(run.code).toBe(1);
    expect(run.err).toContain('team up: the file was never approved on this machine: run `team approve`\n');
    expect(run.out).toBe('');
  });

  test("--dry-run prints the plan for the approved file, with each seat's rules and signature", async () => {
    await approve([], OWNER);
    const run = await up(['--dry-run'], OWNER);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain('! up would refuse');
    const lines = run.out.split('\n');
    expect(lines[0]).toStartWith('+ env -i HOME=$HOME ');
    expect(run.out).toContain(
      `+ herdr --session acme-web workspace create --cwd ${root} --label 'claude opus 5.5' --no-focus\n`,
    );
    expect(run.out).toContain(
      "+ herdr --session acme-web pane run <pane of claude-coordinator-acme> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt '\\''Rules for this session, from the team file:",
    );
    expect(run.out).toContain(
      '- Your signature in a commit message, as a trailer, in a last paragraph of its own that holds trailers only: Agent: Claude Opus 5.5 · project coordinator\n',
    );
    expect(run.out).toContain(
      '- Your signature in a pull request body, as its last line: **Agent:** DeepSeek V4.1 Flash · implementer\n',
    );
    expect(run.out).toContain('- Run a script with its interpreter; never chmod, chown, sudo or recursive rm.\n');
    expect(run.out).toContain('AGENT_UNATTENDED=1 team-deepseek --dangerously-skip-permissions --append-system-prompt');
    expect(run.out).toContain('+ herdr --session acme-web agent rename <pane of deepseek-acme-2> deepseek-acme-2\n');
    expect(run.out).toContain('AGENT_UNATTENDED=1 codex -m gpt-6-sol -c model_reasoning_effort=high -a never -s danger-full-access');
    expect(run.out).toContain('pane send-text <pane of codex-acme>');
    expect(run.out).toContain('  skip grok-acme: stopped in the file; start it with `team add grok-acme`\n');
    expect(run.out).toContain('pane run <pane of watchdog>');
    expect(run.out).toContain('watch --session acme-web');
    expect(run.out).toEndWith('dry run: nothing was run\n');
  });

  test('--dry-run names every refusal `up` would make, and still prints the plan', async () => {
    const run = await up(['--dry-run'], WORKER, {
      sessionRunning: () => true,
      agents: () => [agent('stranger'), agent(null)],
    });
    expect(run.code).toBe(0);
    expect(run.out).toStartWith(
      [
        '! up would refuse: only the owner runs `up`, from a terminal outside herdr; this call is deepseek-acme',
        '! up would refuse: the file was never approved on this machine: run `team approve`',
        "! up would refuse: session acme-web has 2 agents this file's state doesn't record: `up` never touches a running team",
        '+ herdr --session acme-web workspace create',
      ].join('\n'),
    );
  });

  test('--dry-run names an edited file and a silent herdr', async () => {
    await approve([], OWNER);
    edit((text) => text.replace('launch: team-deepseek', 'launch: team-deepseek --yolo'));
    const run = await up(['--dry-run', '--session', 'team-test'], OWNER, { sessionRunning: () => null });
    expect(run.out).toContain(
      '! up would refuse: the file is not the approved one (seat deepseek-acme changed; seat deepseek-acme-2 changed): run `team approve`\n',
    );
    expect(run.out).toContain("! up would refuse: herdr doesn't answer\n");
    expect(run.out).toContain('+ herdr --session team-test workspace create');
  });

  test('a resumed session passes when the state records its agents', async () => {
    await approve([], OWNER);
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: { 'acme-web': { seats: { 'deepseek-acme': { stage: 'ready' } }, worktrees: {} } },
      }),
    );
    const run = await up(['--dry-run'], OWNER, { sessionRunning: () => true, agents: () => [agent('deepseek-acme')] });
    expect(run.out).not.toContain('! up would refuse');
    expect(run.out).not.toContain('env -i');
  });
});

async function down(argv: string[], caller: Caller, overrides: Partial<DownSources> = {}) {
  const io = testIo(root, caller);
  const code = await runDown([...argv, ...FILE], io, {
    sessionRunning: () => true,
    agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme'), agent('deepseek-acme-2', 'working')],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    ...overrides,
  });
  return { code, out: io.out, err: io.err };
}

describe('team down', () => {
  test('a seat other than the coordinator or the operator stops nothing', async () => {
    const run = await down([], WORKER);
    expect(run.code).toBe(1);
    expect(run.err).toContain('team down: only the owner, the coordinator or the operator stops the team; this call is deepseek-acme\n');
    expect(run.out).toBe('');
  });

  test('--dry-run for the owner: free seats are stopped, a working one and the session are left', async () => {
    const run = await down(['--dry-run'], OWNER);
    expect(run.code).toBe(0);
    expect(run.out).toBe(
      [
        '+ herdr --session acme-web pane run claude-coordinator-acme:p1 /exit',
        "  wait until claude-coordinator-acme's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close claude-coordinator-acme',
        '+ herdr --session acme-web pane run deepseek-acme:p1 /exit',
        "  wait until deepseek-acme's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close deepseek-acme',
        '  skip deepseek-acme-2: is working (`--wait` waits for it); left running',
        '  skip session acme-web: not stopped, 1 agent left in it',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test("--dry-run for the coordinator leaves its own seat; another seat's call would be refused", async () => {
    const lead = await down(['--dry-run'], COORDINATOR);
    expect(lead.out).toStartWith(
      "  skip claude-coordinator-acme: left running; only the owner stops the coordinator's or the operator's seat\n+ herdr --session acme-web pane run deepseek-acme:p1 /exit\n",
    );
    expect(lead.out).not.toContain('! down would refuse');

    const worker = await down(['--dry-run'], WORKER);
    expect(worker.out).toStartWith(
      '! down would refuse: only the owner, the coordinator or the operator stops the team; this call is deepseek-acme\n',
    );
  });

  test('--dry-run never closes an agent the file does not name, and stops the watch it knows', async () => {
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'deepseek-acme-tmp-1': { stage: 'ready', temporary: { like: 'deepseek-acme', until: 'result:out.md' } },
            },
            worktrees: {},
            watch: { pid: 4242, heartbeat: '2026-10-03T14:00:00Z' },
          },
        },
      }),
    );
    const run = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme-tmp-1'), agent('stranger'), agent(null), agent('codex-acme', 'blocked')],
    });
    expect(run.out).toStartWith(
      [
        '+ herdr --session acme-web pane run deepseek-acme-tmp-1:p1 /exit',
        "  wait until deepseek-acme-tmp-1's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close deepseek-acme-tmp-1',
        '  skip codex-acme: is blocked at a prompt, which `team` never answers; left running',
        '+ kill 4242',
        '    (the watch)',
        '  skip session acme-web: not stopped, 3 agents left in it',
      ].join('\n'),
    );
    expect(run.out).not.toContain('stranger');
  });

  test('an idle status at a permission prompt is blocked, and unsent text stays unsent', async () => {
    const blocked = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme', 'idle')],
      screen: () => ({ kind: 'permission' }),
    });
    expect(blocked.out).toContain('deepseek-acme: is blocked at a prompt, which `team` never answers; left running');
    expect(blocked.out).not.toContain('pane run deepseek-acme');

    const unsent = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme', 'idle')],
      screen: () => ({ kind: 'unsent' }),
    });
    expect(unsent.out).toContain('deepseek-acme: holds unsent text in its input box; left running');
    expect(unsent.out).not.toContain('pane run deepseek-acme');
  });

  test('a Cursor queue screen is working: its pane is not typed into', async () => {
    const queued = readScreen(
      'cursor',
      readFileSync(new URL('../fixtures/cursor/2026.10.01/follow-up-queue-two.txt', import.meta.url), 'utf8'),
    );
    expect(queued.kind).toBe('working');
    const run = await down(['--dry-run'], OWNER, {
      agents: () => [agent('deepseek-acme', 'idle')],
      screen: () => queued,
    });
    expect(run.out).toContain('deepseek-acme: is working (`--wait` waits for it); left running');
    expect(run.out).not.toContain('pane run deepseek-acme');
  });

  test('--dry-run on a session that is not running, or a silent herdr', async () => {
    const stopped = await down(['--dry-run'], OWNER, { sessionRunning: () => false });
    expect(stopped).toMatchObject({
      code: 0,
      out: 'session acme-web is not running: nothing to stop\ndry run: nothing was run\n',
    });
    expect((await down(['--dry-run'], OWNER, { sessionRunning: () => null })).code).toBe(2);
    expect((await down(['--dry-run'], OWNER, { agents: () => null })).code).toBe(2);
  });

  test('a session every seat leaves is stopped and cleared in the same run, and the dry run says so', async () => {
    const free = {
      agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme'), agent('deepseek-acme-2')],
    };
    const dry = await down(['--dry-run'], OWNER, free);
    expect(dry.code).toBe(0);
    expect(dry.out).toEndWith(
      [
        '+ herdr session stop acme-web',
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test('a session herdr reports stopped before down acts is only reported, not stopped or cleared', async () => {
    const run = await down([], OWNER, { sessionRunning: () => false });
    expect(run).toMatchObject({ code: 0, out: 'session acme-web is not running: nothing to stop\n' });
  });

  test('a pane back at its shell is not the seat any more', () => {
    expect(paneStillRunning(['claude'], ['claude'])).toBe(true);
    expect(paneStillRunning(['zsh'], ['claude'])).toBe(false);
    expect(paneStillRunning([], ['claude'])).toBe(false);
    expect(paneStillRunning(null, ['claude'])).toBe(true);
  });
});
