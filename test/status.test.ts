import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReadings, saveSpendReadings } from '../src/budgets/readings.ts';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus } from '../src/commands/status.ts';
import type { StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Standing } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { runningModel } from '../src/status/statusline.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
const codexScreen = (name: string) => readFileSync(new URL(`./fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it, fully built: grok-acme is stopped in the file.
function built(): Live {
  return {
    running: true,
    agents: [
      agent('claude-coordinator-acme', 'w1', 'working'),
      agent('codex-acme', 'w2', 'idle', 'codex'),
      agent('deepseek-acme', 'w3', 'done'),
      agent('deepseek-acme-2', 'w4'),
    ],
    workspaces: [
      { id: 'w1', label: 'claude opus 5.5' }, { id: 'w2', label: 'gpt sol 6' },
      { id: 'w3', label: 'deepseek flash v4.1' }, { id: 'w4', label: 'deepseek flash v4.1-2' }, { id: 'w9', label: 'watchdog' },
    ],
    screens: { 'w1:p1': claudeScreen('Opus 5.5') },
  };
}

let dir: string;
let file: string;
let live: Live | null;
let branch: string | null;

// The standing the report runs on: by default the file as approved, with no drift.
let standing: Standing;
const sources: StatusSources = {
  live: () => live,
  branch: () => branch,
  standing: () => standing,
  now: () => NOW,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-status-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  live = built();
  branch = 'main';
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function status(...argv: string[]) {
  const io = testIo(dir);
  const code = await runStatus(['--file', file, ...argv], io, sources);
  return { code, out: io.out, err: io.err };
}

// Approve whatever the file on disk now holds: the tests below rewrite the file and mean the
// change to be in force, not a drift against the record beforeEach built.
function approveOnDisk() {
  const text = readFileSync(file, 'utf8');
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the rewritten file does not validate: ${JSON.stringify(parsed.errors)}`);
  standing = verifiedOf(parsed.team, text, dir, NOW);
}

describe('team status', () => {
  test('a team that matches its file reads clean and exits 0', async () => {
    const { code, out } = await status();
    expect(out).toContain('team acme-web, session "acme-web"');
    expect(out).toMatch(/claude-coordinator-acme\s+working\s+Claude Opus 5\.5\s+w1:p1/);
    expect(out).toMatch(/codex-acme\s+idle, parked/);
    expect(out).toMatch(/grok-acme\s+stopped/);
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('a seat whose model can\'t be read is a note, not a difference', async () => {
    const { code, out } = await status();
    expect(out).toContain('note: codex-acme: version unread');
    expect(code).toBe(0);
  });

  test('a missing seat, with its repair', async () => {
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const { code, out } = await status();
    expect(out).toContain('difference: deepseek-acme-2 is in the file and is not running\n  repair: team add deepseek-acme-2');
    expect(out).toContain('1 difference(s)');
    expect(code).toBe(1);
  });

  test('a session that is not running: every seat is missing, and the repair is team up', async () => {
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const { code, out } = await status();
    expect(out).toContain('note: the herdr session "acme-web" is not running');
    expect(out).toContain('repair: the owner runs team up');
    expect(out).not.toContain('grok-acme is in the file');
    expect(out).toContain('4 difference(s)');
    expect(code).toBe(1);
  });

  test('an agent in a seat\'s workspace under another name, or none', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = state.sessions['acme-web'] ?? emptySession();
      session.seats['deepseek-acme'] = { stage: 'ready', workspace: 'w3', pane: 'w3:p1' };
      session.seats['codex-acme'] = { stage: 'ready', workspace: 'w2', pane: 'w2:p1' };
      state.sessions['acme-web'] = session;
    });
    const agents = built().agents.map((one) => (one.name === 'deepseek-acme' ? { ...one, name: null } : one.name === 'codex-acme' ? { ...one, name: 'codex-old' } : one));
    live = { ...built(), agents };
    const { out } = await status();
    expect(out).toContain('deepseek-acme: the agent in w3:p1 is unnamed\n  repair: herdr --session acme-web agent rename w3:p1 deepseek-acme');
    expect(out).toContain('codex-acme: the agent in w2:p1 is named "codex-old"');
    expect(out).not.toContain('deepseek flash v4.1');
    expect(out).not.toContain('gpt sol 6');
    expect(out).toContain('2 difference(s)');
  });

  test('an agent the file doesn\'t hold; the watch\'s own workspace is not one', async () => {
    live = { ...built(), agents: [...built().agents, agent('stranger', 'w7'), agent(null, 'w9')] };
    const { out } = await status();
    expect(out).toContain('difference: stranger (w7:p1) is running and is not in the file');
    expect(out).toContain('1 difference(s)');
  });

  test('a seat that runs another model than the file\'s', async () => {
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Fable 5.1') } };
    const { code, out } = await status();
    expect(out).toContain('difference: claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5');
    expect(code).toBe(1);
  });

  // Each profile's own status line, through the same comparison: the codex seat's captured
  // footer names another model, and an id the map doesn't know is unread, never a difference.
  test('a codex seat whose captured status line names another model', async () => {
    live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { code, out } = await status();
    expect(out).toContain('difference: codex-acme runs GPT Terra 5.6; the file says GPT-6 Sol');
    expect(code).toBe(1);
  });

  // A seat with a `display` is spelled by it everywhere: the table's model column and the
  // difference line name the declared model in the same spelling (doctor's lines and the
  // watch's drift notice are held to the same one by their own tests).
  test('the table and the difference line spell a display seat alike', async () => {
    live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { out } = await status();
    expect(out).toContain('(file: GPT-6 Sol)');
    expect(out).toContain('the file says GPT-6 Sol');
    expect(out).not.toContain('the file says GPT Sol 6');
  });

  test('a status-line id the map doesn\'t know is unread: a note, never a difference', async () => {
    const screen = codexScreen('idle').replace('GPT-5.6-Terra medium ·', 'GPT-9-Nova medium ·');
    live = { ...built(), screens: { ...built().screens, 'w2:p1': screen } };
    const { code, out } = await status();
    expect(out).toContain('note: codex-acme: version unread');
    expect(out).not.toContain('codex-acme runs');
    expect(code).toBe(0);
  });

  // Claude Code's line names Claude's families only: the DeepSeek seat's own status line says
  // nothing to compare, so it is unread rather than wrong.
  test('a seat that runs another maker\'s model through Claude Code is unread, never a mismatch', async () => {
    live = { ...built(), screens: { ...built().screens, 'w3:p1': claudeScreen('Opus 5.5') } };
    const { code, out } = await status();
    expect(out).toContain('note: deepseek-acme: version unread');
    expect(out).not.toContain('deepseek-acme runs');
    expect(code).toBe(0);
  });

  test('a stopped seat that runs', async () => {
    live = { ...built(), agents: [...built().agents, agent('grok-acme', 'w5', 'idle', 'grok')] };
    const { out } = await status();
    expect(out).toContain('grok-acme is marked stopped in the file and is running');
  });

  test('what the state records: a launch that stopped, rules not delivered, a temporary seat, a failed setup', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = state.sessions['acme-web'] ?? emptySession();
      session.seats['codex-acme'] = { stage: 'named' };
      session.seats['deepseek-acme'] = { stage: 'ready', rules: 'undelivered' };
      session.seats['codex-acme-tmp-1'] = { stage: 'ready', temporary: { like: 'codex-acme', until: 'merged:fix/select-width' } };
      session.seats['codex-acme-tmp-2'] = { stage: 'ready', temporary: { like: 'codex-acme', until: 'result:out.md' } };
      session.worktrees['select-width'] = { path: '../worktrees/acme-web/select-width', branch: 'fix/select-width', setup: 'failed' };
    });
    live = { ...built(), agents: [...built().agents, agent('codex-acme-tmp-1', 'w6', 'working', 'codex')] };
    const { out } = await status();
    expect(out).toContain('codex-acme: its launch stopped at "named"\n  repair: the owner runs team up (it resumes the launch)');
    expect(out).toContain('deepseek-acme: its rules were not delivered');
    expect(out).toContain('note: codex-acme-tmp-1 is temporary, until merged:fix/select-width');
    expect(out).toContain('codex-acme-tmp-2: a temporary seat is recorded and is not running');
    expect(out).toContain('worktree select-width: its setup failed\n  repair: team worktree remove select-width');
    expect(out).toContain('4 difference(s)');
  });

  test('a watch whose last pass is older than two intervals, and no watch at all', async () => {
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ?? emptySession()).watch = { pid: 1, heartbeat: '2026-10-03T14:00:00Z' };
    });
    expect((await status()).out).toContain('the watch\'s last pass was 10 minute(s) ago\n  repair: team watch --session acme-web');
    updateState(join(dir, '.agents'), (state) => {
      delete state.sessions['acme-web']?.watch;
    });
    expect((await status()).out).toContain('no watch has run for this session');
  });

  test('a protected checkout off its branch', async () => {
    branch = 'fix/select-width';
    const { code, out } = await status();
    expect(out).toContain('the protected checkout "." is on "fix/select-width", not on "main"');
    expect(code).toBe(1);
  });

  test('a file changed since the owner approved it, and one never approved', async () => {
    // What the owner approved: one rules line and grok's model differ from the file on disk.
    const approvedText = example
      .replace('- Run the tests your change touches, not the whole suite.', '- Run the tests your change touches.')
      .replace('    model: Grok\n', '    model: Grok 5\n');
    const approvedFile = validateTeamFile(approvedText);
    if (!approvedFile.ok) throw new Error('the approved variant does not validate');
    standing = verifiedOf(approvedFile.team, approvedText, dir, NOW);
    const changed = await status();
    expect(changed.out).toContain('difference: the file differs from the approved one: `rules` changed\n  repair: the owner runs team approve');
    expect(changed.out).toContain('2 difference(s)');
    standing = { kind: 'none' };
    expect((await status()).out).toContain('difference: the file was never approved on this machine');
  });

  test('--session reads another session, with its own state', async () => {
    const { out } = await status('--session', 'team-test');
    expect(out).toContain('session "team-test"');
    expect(out).toContain('no watch has run for this session\n  repair: team watch --session team-test');
  });

  test('a broken file: status falls back to the last valid copy and says so first', async () => {
    await status();
    expect(readState(join(dir, '.agents')).last_valid?.file).toBe(example);
    writeFileSync(file, example.replace('format: 1', 'format: 9'));
    const { code, out } = await status();
    expect(out.split('\n')[0]).toBe('team.yaml is invalid (line 1: format must be 1: this version of team reads no other); using the copy of 2026-10-03T14:10:00.000Z');
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('a broken file with no valid copy: the problems, with their lines', async () => {
    writeFileSync(file, 'format: 9\n');
    const { code, err } = await status();
    expect(err).toContain('team.yaml line 1: format must be 1');
    expect(code).toBe(2);
  });

  test('a named account with no reading is unknown, and a stored reading is a row', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }
`,
    ));
    approveOnDisk();
    saveReadings(join(dir, '.agents'), [{
      account: 'openai',
      window: 'weekly',
      left: 39,
      used: 61,
      changedAt: NOW.getTime() - 2 * 60 * 1000,
      resetsAt: NOW.getTime() + 44 * 60 * 1000,
      seat: 'codex-acme',
      source: 'status_line',
      confirmed: true,
    }], NOW.getTime());
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('openai  weekly  left 39%  used 61%  resets in 44m  codex-acme  changed 2m ago  status line  fresh');
    expect(out).toContain('deepseek  unknown');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'deepseek', window: null, left: null, used: null, resetsIn: null, seat: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: null },
      { account: 'openai', window: 'weekly', left: 39, used: 61, resetsIn: '44m', seat: 'codex-acme', age: '2m', source: 'status_line', fallback: false, state: 'fresh', inside: false, reserve: 10 },
    ]);
  });

  test('a stored spend reading prints no figure: its row is unknown in the table and the JSON', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }
`,
    ));
    approveOnDisk();
    saveSpendReadings(join(dir, '.agents'), [
      { account: 'deepseek', amount: 4.996, currency: 'USD', at: NOW.getTime() - 3 * 60 * 1000 },
    ]);
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('deepseek  unknown');
    expect(out).not.toContain('4.996');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'deepseek', window: null, left: null, used: null, resetsIn: null, seat: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: null },
    ]);
  });

  test('a stored check reading is a row with its own source, and no seat', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check, status_line], check: openai-usage }
`,
    ));
    approveOnDisk();
    saveReadings(join(dir, '.agents'), [{
      account: 'openai',
      window: 'weekly',
      left: 5,
      used: 95,
      changedAt: NOW.getTime() - 2 * 60 * 1000,
      resetsAt: null,
      seat: null,
      source: 'check',
      confirmed: true,
    }], NOW.getTime());
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('openai  weekly  left 5%  used 95%  resets unknown  -  read 2m ago  check  fresh, inside reserve 10%');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'openai', window: 'weekly', left: 5, used: 95, resetsIn: null, seat: null, age: '2m', source: 'check', fallback: false, state: 'fresh', inside: true, reserve: 10 },
    ]);
  });

  test('a figure the account\'s first source did not give is marked a fallback', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check, status_line], check: openai-usage }
`,
    ));
    approveOnDisk();
    saveReadings(join(dir, '.agents'), [{
      account: 'openai',
      window: 'weekly',
      left: 39,
      used: 61,
      changedAt: NOW.getTime() - 2 * 60 * 1000,
      resetsAt: NOW.getTime() + 44 * 60 * 1000,
      seat: 'codex-acme',
      source: 'status_line',
      confirmed: true,
    }], NOW.getTime());
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('openai  weekly  left 39%  used 61%  resets in 44m  codex-acme  changed 2m ago  status line (fallback)  fresh');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resetsIn: '44m', seat: 'codex-acme', age: '2m', source: 'status_line', fallback: true, state: 'fresh', inside: false, reserve: 10 },
    ]);
  });

  test('no budgets table when the file names no account and nothing is stored', async () => {
    const { out } = await status();
    const json = JSON.parse((await status('--json')).out);
    expect(out).not.toContain('budgets:');
    expect(json.budgets).toBeUndefined();
  });

  test('herdr that doesn\'t answer, and a bad option', async () => {
    live = null;
    expect(await status()).toMatchObject({ code: 2, err: expect.stringContaining('herdr doesn\'t answer') });
    expect(await status('--fix')).toMatchObject({ code: 2, err: expect.stringContaining('unknown option --fix') });
    expect((await status('--fix')).err).toContain('Usage: team status [--session <name>] [--file <path>] [--json]\n');
  });

  test('--json: pins the stable format 1 shape on a clean team', async () => {
    const { code, out, err } = await status('--json');
    expect(code).toBe(0);
    expect(err).toBe('');
    const doc = JSON.parse(out);
    expect(Object.keys(doc).sort()).toEqual(['differences', 'format', 'notes', 'notice', 'project', 'rows', 'session']);
    expect(doc.format).toBe(1);
    expect(doc.project).toBe('acme-web');
    expect(doc.session).toBe('acme-web');
    expect(doc.notice).toBeNull();
    expect(doc.differences).toEqual([]);
    expect(doc.notes).toEqual([
      'approval #1 (2026-10-03)',
      'codex-acme: version unread (its screen doesn\'t show the model)',
      'deepseek-acme: version unread (its screen doesn\'t show the model)',
      'deepseek-acme-2: version unread (its screen doesn\'t show the model)',
    ]);
    expect(doc.rows).toEqual([
      { name: 'claude-coordinator-acme', state: 'working', model: 'Claude Opus 5.5', pane: 'w1:p1' },
      { name: 'codex-acme', state: 'idle, parked', model: 'GPT-6 Sol (unread)', pane: 'w2:p1' },
      { name: 'deepseek-acme', state: 'done', model: 'DeepSeek V4.1 Flash (unread)', pane: 'w3:p1' },
      { name: 'deepseek-acme-2', state: 'idle', model: 'DeepSeek V4.1 Flash (unread)', pane: 'w4:p1' },
      { name: 'grok-acme', state: 'stopped', model: 'Grok 4.7', pane: '-' },
    ]);
  });

  test('--json: reports differences with exit 1 and the same structure', async () => {
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const { code, out } = await status('--json');
    expect(code).toBe(1);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.differences).toEqual([
      { what: 'deepseek-acme-2 is in the file and is not running', repair: 'team add deepseek-acme-2' },
    ]);
  });

  test('--json: includes notice when falling back to last valid copy', async () => {
    await status();
    writeFileSync(file, example.replace('format: 1', 'format: 9'));
    const { code, out } = await status('--json');
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.notice).toContain('team.yaml is invalid');
    expect(doc.differences).toEqual([]);
  });

  test('--json: notes when session is not running', async () => {
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const { code, out } = await status('--json');
    expect(code).toBe(1);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.notes).toContain('the herdr session "acme-web" is not running');
    expect(doc.differences.length).toBe(4);
  });

  test('A: the approval repair comes first and marks the repairs that wait on it; a missing watch marks nothing', async () => {
    // 1. A missing watch and two seats not running: the watch moves nothing and marks nothing
    live = {
      ...built(),
      agents: built().agents.filter(
        (one) => one.name !== 'deepseek-acme' && one.name !== 'deepseek-acme-2',
      ),
    };
    updateState(join(dir, '.agents'), (state) => {
      delete state.sessions['acme-web']?.watch;
    });

    const missingWatch = await status();
    expect(missingWatch.code).toBe(1);
    const add1 = missingWatch.out.indexOf('difference: deepseek-acme is in the file and is not running\n  repair: team add deepseek-acme\n');
    const add2 = missingWatch.out.indexOf('difference: deepseek-acme-2 is in the file and is not running\n  repair: team add deepseek-acme-2\n');
    const watch = missingWatch.out.indexOf('difference: no watch has run for this session\n  repair: team watch --session acme-web\n');
    expect(add1).toBeGreaterThanOrEqual(0);
    expect(add2).toBeGreaterThanOrEqual(0);
    // The differences keep the order they were created in: the watch's, made after them, stays after them.
    expect(watch).toBeGreaterThan(add1);
    expect(watch).toBeGreaterThan(add2);
    expect(missingWatch.out).not.toContain('(after:');

    // 2. An unapproved file: the approval difference first, then the repairs that name a command
    //    that refuses on it. The watch is not blocked by the approval and is not marked either.
    standing = { kind: 'none' };
    const unapproved = await status();
    expect(unapproved.code).toBe(1);
    const approve = unapproved.out.indexOf('difference: the file was never approved on this machine\n  repair: the owner runs team approve');
    expect(approve).toBeGreaterThanOrEqual(0);
    expect(unapproved.out).toContain('repair: team add deepseek-acme (after: the owner runs team approve)');
    expect(unapproved.out).toContain('repair: team add deepseek-acme-2 (after: the owner runs team approve)');
    expect(unapproved.out.indexOf('difference: deepseek-acme is in the file and is not running')).toBeGreaterThan(approve);
    expect(unapproved.out).toContain('difference: no watch has run for this session\n  repair: team watch --session acme-web\n');
  });

  test('B: whose repair: each repair string that names an owner command asserted exactly', async () => {
    // 1. the owner runs team approve
    standing = { kind: 'none' };
    const approveRun = await status();
    expect(approveRun.out).toContain('repair: the owner runs team approve');

    // 2. the owner runs team up
    const validTeam = validateTeamFile(example);
    if (!validTeam.ok) throw new Error('invalid example');
    standing = verifiedOf(validTeam.team, example, dir, NOW);
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const upRun = await status();
    expect(upRun.out).toContain('repair: the owner runs team up');

    // 3. the owner runs team up (it resumes the launch)
    live = built();
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'launched' };
    });
    const resumeRun = await status();
    expect(resumeRun.out).toContain('repair: the owner runs team up (it resumes the launch)');

    // 4. the owner switches it back: git -C <shown> switch <base>
    branch = 'fix/other';
    const switchRun = await status();
    expect(switchRun.out).toContain('repair: the owner switches it back: git -C . switch main');
    branch = 'main';

    // 5. the owner clears or sends it in the pane; team does not type into a box it can't verify
    const codexUnsent = codexScreen('unsent');
    live = {
      ...built(),
      screens: { ...built().screens, 'w2:p1': codexUnsent },
    };
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'ready' };
    });
    const unsentRun = await status();
    expect(unsentRun.out).toContain(
      "repair: the owner clears or sends it in the pane; team does not type into a box it can't verify",
    );

    // 6. the owner clears or sends it in the pane, then runs team up (it resumes the launch)
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'named' };
    });
    const mergedRun = await status();
    expect(mergedRun.out).toContain(
      'repair: the owner clears or sends it in the pane, then runs team up (it resumes the launch)',
    );
  });

  test('C: unsent text: table cell, difference, merged form for named seat, unchanged for unknown', async () => {
    const codexUnsent = codexScreen('unsent');

    // Seat reads unsent (stage: ready)
    live = {
      ...built(),
      screens: { ...built().screens, 'w2:p1': codexUnsent },
    };
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'ready' };
    });
    const unsentRes = await status();
    expect(unsentRes.out).toMatch(/codex-acme\s+idle \(unsent text\), parked/);
    expect(unsentRes.out).toContain('difference: codex-acme holds text in its input box that was never sent');
    expect(unsentRes.out).toContain("repair: the owner clears or sends it in the pane; team does not type into a box it can't verify");

    // merged form for a named seat
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'named' };
    });
    const namedRes = await status();
    expect(namedRes.out).toContain('difference: codex-acme: its launch stopped at "named", and it holds text in its input box that was never sent');
    expect(namedRes.out).toContain('repair: the owner clears or sends it in the pane, then runs team up (it resumes the launch)');
    expect(namedRes.out).not.toContain('difference: codex-acme holds text in its input box that was never sent');

    // seat that reads unknown: unchanged output
    live = {
      ...built(),
      screens: { ...built().screens, 'w2:p1': 'Some unknown output without composer\n' },
    };
    const unknownRes = await status();
    expect(unknownRes.out).toMatch(/codex-acme\s+idle, parked/);
    expect(unknownRes.out).toContain('difference: codex-acme: its launch stopped at "named"\n  repair: the owner runs team up (it resumes the launch)');
    expect(unknownRes.out).not.toContain('unsent text');
    expect(unknownRes.out).not.toContain('holds text in its input box that was never sent');
  });

  test('C2: done is as free as idle — unsent text is read for both; working and blocked are not', async () => {
    const codexUnsent = codexScreen('unsent');
    const base = built();
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'ready' };
    });

    const withStatus = async (state: string) => {
      live = {
        ...base,
        agents: base.agents.map((one) => (one.name === 'codex-acme' ? { ...one, status: state } : one)),
        screens: { ...base.screens, 'w2:p1': codexUnsent },
      };
      return status();
    };

    // idle: as before
    const idle = await withStatus('idle');
    expect(idle.out).toMatch(/codex-acme\s+idle \(unsent text\), parked/);
    expect(idle.out).toContain('difference: codex-acme holds text in its input box that was never sent');

    // done: the same reading and the same difference — team types into a done box too
    const done = await withStatus('done');
    expect(done.out).toMatch(/codex-acme\s+done \(unsent text\), parked/);
    expect(done.out).toContain('difference: codex-acme holds text in its input box that was never sent');

    // working and blocked: the box is not team's to read as unsent text
    for (const state of ['working', 'blocked']) {
      const other = await withStatus(state);
      expect(other.out).toMatch(new RegExp(`codex-acme\\s+${state}, parked`));
      expect(other.out).not.toContain('unsent text');
      expect(other.out).not.toContain('holds text in its input box that was never sent');
    }
  });

  test('D: summary line: with and without an owner repair', async () => {
    // 1. Without an owner repair: only a missing seat (repair: team add <seat>)
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const noOwner = await status();
    expect(noOwner.out).toContain('1 difference(s)\n');
    expect(noOwner.out).not.toContain('for the owner');

    // 2. With an owner repair: unapproved file (repair: the owner runs team approve)
    live = built();
    standing = { kind: 'none' };
    const withOwner = await status();
    expect(withOwner.out).toContain('1 difference(s), 1 for the owner\n');

    // 3. Mixed: 1 owner repair (approve) + 1 non-owner repair (add)
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const mixed = await status();
    expect(mixed.out).toContain('2 difference(s), 1 for the owner\n');
  });
});

// A pane is its seat only while the process team launched is still in it. Each case records a
// launch for codex-acme and hands the comparison one process-info reading for its pane.
describe('a pane that no longer holds the process team launched', () => {
  const GONE_REPAIR = '  repair: the owner runs team up\n';

  function recordCodex(patch: Record<string, unknown> = {}) {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['codex-acme'] = {
        stage: 'ready',
        pane: 'w2:p1',
        workspace: 'w2',
        launched: { shell: 400, cli: [401] },
        ...patch,
      };
    });
  }

  test('gone: the table cell, the difference, the repair and the JSON row', async () => {
    recordCodex();
    // The CLI ended, or the session was restored: the pane's own shell is what is left in front.
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [400] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+missing\s+GPT-6 Sol\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: its pane runs no CLI (the CLI ended or the session was restored)\n' + GONE_REPAIR,
    );
    expect(out).toContain('1 difference(s), 1 for the owner\n');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.rows.find((row: { name: string }) => row.name === 'codex-acme')).toEqual({
      name: 'codex-acme',
      state: 'missing',
      model: 'GPT-6 Sol',
      pane: 'w2:p1',
    });
  });

  test('replaced: never idle, never under the declared model', async () => {
    recordCodex();
    // Another CLI runs in the pane — the session was restored with a program team did not launch.
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [500] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+restored, not launched by team\s+-\s+w2:p1/);
    expect(out).not.toMatch(/codex-acme\s+idle/);
    expect(out).toContain(
      'difference: codex-acme: the process in its pane is not the one team launched; nothing checks its model, account or rules\n' +
        GONE_REPAIR,
    );
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.rows.find((row: { name: string }) => row.name === 'codex-acme')).toEqual({
      name: 'codex-acme',
      state: 'restored, not launched by team',
      model: '-',
      pane: 'w2:p1',
    });
  });

  test('gone with no agent listed: its pane is read, not called a missing seat', async () => {
    recordCodex();
    // The name went from herdr's agent list with the CLI. Its recorded pane still stands, and the
    // shell in it is read: this is the launch that ended, not a seat a rename could put right.
    live = {
      ...built(),
      agents: built().agents.filter((one) => one.name !== 'codex-acme'),
      processes: { 'w2:p1': { shell: 400, foreground: [400] } },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+missing\s+GPT-6 Sol\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: its pane runs no CLI (the CLI ended or the session was restored)\n' + GONE_REPAIR,
    );
    expect(out).not.toContain('codex-acme is in the file and is not running');
  });

  test('replaced with no agent listed: the pane is not renamed into a seat', async () => {
    recordCodex();
    // A stranger runs in the recorded pane under no name of the file's: before, this pane was a
    // stray to rename into the seat. It is not the seat, and it is not ours to name.
    live = {
      ...built(),
      agents: [
        ...built().agents.filter((one) => one.name !== 'codex-acme'),
        agent('stranger', 'w2', 'idle', 'codex'),
      ],
      processes: { 'w2:p1': { shell: 400, foreground: [500] } },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+restored, not launched by team\s+-\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: the process in its pane is not the one team launched; nothing checks its model, account or rules\n' +
        GONE_REPAIR,
    );
    expect(out).not.toContain('is named "stranger"');
    expect(out).not.toContain('agent rename');
  });

  test('a reading herdr cannot give keeps today: the seat reads as it did before', async () => {
    recordCodex();
    live = { ...built(), processes: { 'w2:p1': null } };
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toMatch(/codex-acme\s+idle, parked/);
    expect(out).not.toContain('its pane runs no CLI');
  });

  test('a seat with no record keeps today, even with the shell in front of its pane', async () => {
    // An older version wrote this state; nothing was recorded, so nothing is compared.
    recordCodex({ launched: undefined });
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [400] } } };
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toMatch(/codex-acme\s+idle, parked/);
    expect(out).not.toContain('its pane runs no CLI');
  });
});

describe('the status line of Claude Code', () => {
  test('is read from a real screen', () => {
    const screen = `❯\n${'─'.repeat(40)}\n  main · …/floor/docs · Opus 5.5 · S: $5.8 ⣿⣄⣀⣀⣀ 24% · L: 20% (2h6m) · W: 12% (+13.3%) (125h26m)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n`;
    expect(runningModel('claude-code', screen)).toEqual({ model: 'Claude Opus', version: '5.5' });
  });
  test('is unread when the screen doesn\'t show it, and for a CLI without a normalisation', () => {
    expect(runningModel('claude-code', 'Do you want to proceed?\n1. Yes\n')).toBeNull();
    expect(runningModel('codex', 'GPT-6-Sol high')).toBeNull();
    expect(runningModel('antigravity', 'Do you trust the contents of this project?\n> Yes, I trust this folder\n')).toBeNull();
  });
  test('is read from an Antigravity screen', () => {
    const screen = 'Antigravity CLI\n? for shortcuts               Gemini 3.8 Flash · high\n';
    expect(runningModel('antigravity', screen)).toEqual({ model: 'Gemini Flash', version: '3.8' });
  });
});
