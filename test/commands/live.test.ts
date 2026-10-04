import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/commands/approve.ts';
import { realSources as downReal, runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { realSources as upReal, runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { sessionState, type HerdrAgent } from '../../src/herdr.ts';
import { storePath } from '../../src/store/store.ts';
import { readState } from '../../src/state.ts';
import { parseMemoryPressure, parseSwapUsage, type Machine } from '../../src/watch/machine.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { agyMismatchedFrame, claudeBox, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';
const CLOSING_MESSAGE = 'These are standing rules, not a task: reply ready and wait for your brief.';
const CLOSING_OPTION = 'These are standing rules, not a task.';

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-live-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const store = () => storePath('acme-web', root, home);

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', now: () => NOW, home });
  expect(code).toBe(0);
}

function agent(name: string, pane: string, status = 'idle'): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
}

function doctor(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

type World = {
  launch: Launch;
  starts: number;
  creates: string[];
  runs: { pane: string; command: string }[];
  renames: string[];
  closes: string[];
  session: 'absent' | 'running' | 'stopped';
  seed(pane: string, text: string, agent: boolean): void;
};

function world(text: string | ((pane: string, label: string) => string) = IDLE): World {
  const state: World = {
    launch: {} as Launch,
    starts: 0,
    creates: [],
    runs: [],
    renames: [],
    closes: [],
    session: 'absent',
    seed(pane, shown, agent) {
      panes.set(pane, { text: shown, agent });
    },
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean }>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.starts++;
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      const shown = typeof text === 'string' ? text : text(pane, label);
      panes.set(pane, { text: shown, agent: false });
      state.creates.push(label);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      state.runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      state.renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      state.closes.push(workspace);
      return true;
    },
    agentPanes() {
      return [...panes].filter(([, pane]) => pane.agent).map(([id]) => id);
    },
    paneText(_session, pane) {
      return panes.get(pane)?.text ?? '';
    },
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return state;
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    ...extra,
  };
}

describe('team up, live', () => {
  test('rules are not typed into a pane with no live agent', async () => {
    const path = join(root, '.agents/team.yaml');
    writeFileSync(path, EXAMPLE.replace('stopped: true\n', 'parked: true\n'));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'gpt sol 6' ? capture('idle') : IDLE));
    const sent: string[] = [];
    made.launch.agentStatus = () => 'idle';
    made.launch.foreground = () => ['zsh'];
    made.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(sent).toEqual([]);
    expect(io.out).toContain('codex-acme: no live agent in its pane; its rules were not delivered');
  });

  test.each(['accepted', 'trust', 'startup', 'swallowed'] as const)('Codex first-message rules: %s', async (outcome) => {
    const path = join(root, '.agents/team.yaml');
    writeFileSync(path, EXAMPLE.replace('stopped: true\n', 'parked: true\n'));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => label === 'gpt sol 6'
      ? capture(outcome === 'trust' || outcome === 'startup' ? outcome : 'idle') : IDLE);
    let codexPane = '';
    let status = 'idle';
    const sent: string[] = [];
    const read = made.launch.paneText;
    let pasted = false;
    let typed = '';
    // The pane with the paste rendered: the idle frame's placeholder row replaced by the typed
    // message, later lines at the prompt's own column, as the fixtures README describes.
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return capture('idle').replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.agentStatus = () => status;
    made.launch.typeText = (_session, pane, text) => { codexPane = pane; typed = text; sent.push(text); pasted = true; return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); if (outcome === 'accepted') { status = 'working'; pasted = false; } return true; };
    made.launch.paneText = (session, pane) => pane === codexPane
      ? (pasted ? boxed() : capture('working')) : read(session, pane);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'];
    if (outcome === 'accepted') {
      expect(code).toBe(0);
      expect(seat).toMatchObject({ stage: 'ready', rules: 'message' });
      expect(sent[0]).toContain('Agent: GPT-6 Sol · implementer');
      // The typed first message is answered once, so it asks for the ready reply.
      expect(sent[0]).toEndWith(CLOSING_MESSAGE);
      expect(sent[1]).toBe('Enter');
      expect(made.runs.some(({ command }) => command.startsWith('Rules for this session'))).toBe(false);
    } else if (outcome === 'swallowed') {
      expect(code).toBe(1);
      expect(seat?.stage).toBe('named');
      expect(seat?.rules).toBeUndefined();
      expect(io.out).toContain('its rules were not delivered; left at named');
    } else {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(seat).toBeUndefined();
      expect(made.closes).toContain('w2');
      expect(made.renames).not.toContain('codex-acme');
    }
  });

  test.each(['accepted', 'trust', 'swallowed'] as const)('Antigravity first-message rules: %s', async (outcome) => {
    const path = join(root, '.agents/team.yaml');
    const gemini = [
      '  - role: implementer',
      '    name: gemini-acme',
      '    cli: antigravity',
      '    vendor: google',
      '    model: Gemini Flash',
      '    version: "3.8"',
      '    display: Gemini 3.8 Flash',
      '    launch: agy',
      '    parked: true',
    ].join('\n');
    writeFileSync(path, EXAMPLE.replace(/  - role: implementer\n    name: codex-acme[\s\S]*?stopped: true\n/, `${gemini}\n`));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/antigravity/1.2.16/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'gemini flash 3.8'
      ? capture(outcome === 'trust' ? outcome : 'idle') : IDLE));
    let geminiPane = '';
    let status = 'idle';
    const sent: string[] = [];
    const read = made.launch.paneText;
    let pasted = false;
    let typed = '';
    // The pane with the paste rendered: the idle frame's bare prompt row replaced by the typed
    // message, later lines at the prompt's own column, as the fixtures README describes.
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
      return capture('idle').replace('\n>\n', `\n${body}\n`);
    };
    made.launch.agentStatus = () => status;
    made.launch.typeText = (_session, pane, text) => { geminiPane = pane; typed = text; sent.push(text); pasted = true; return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); if (outcome === 'accepted') { status = 'working'; pasted = false; } return true; };
    made.launch.paneText = (session, pane) => (pane === geminiPane
      ? (pasted ? boxed() : capture('working')) : read(session, pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['gemini-acme'];
    if (outcome === 'accepted') {
      expect(code).toBe(0);
      expect(seat).toMatchObject({ stage: 'ready', rules: 'message' });
      expect(sent[0]).toContain('Agent: Gemini 3.8 Flash · implementer');
      // The typed first message is answered once, so it asks for the ready reply.
      expect(sent[0]).toEndWith(CLOSING_MESSAGE);
      expect(sent[1]).toBe('Enter');
      expect(made.runs.some(({ command }) => command.startsWith('Rules for this session'))).toBe(false);
    } else if (outcome === 'swallowed') {
      expect(code).toBe(1);
      expect(seat?.stage).toBe('named');
      expect(seat?.rules).toBeUndefined();
      expect(io.out).toContain('its rules were not delivered; left at named');
    } else {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(seat).toBeUndefined();
      expect(made.closes).toContain('w2');
      expect(made.renames).not.toContain('gemini-acme');
    }
  });

  test('launches each claude-code seat, names it, and starts the watch', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(made.starts).toBe(1);
    expect(made.creates).toEqual([
      'claude opus 5.5',
      'deepseek flash v4.1',
      'deepseek flash v4.1-2',
      'watchdog',
    ]);
    expect(made.renames).toEqual(['claude-coordinator-acme', 'deepseek-acme', 'deepseek-acme-2']);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).toContain('watch: started\n');
    expect(io.out).toContain('skip codex-acme:');
    expect(io.out).toContain('skip grok-acme:');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
    expect(seats['claude-coordinator-acme']?.rules).toBe('option');
    expect(seats['deepseek-acme-2']?.pane).toBe('w3:p1');
    // The system-prompt option stays in force on every later turn: it closes without asking for a reply.
    const launches = made.runs.filter(({ command }) => command.includes('--append-system-prompt'));
    expect(launches).toHaveLength(3);
    for (const { command } of launches) {
      expect(command).toEndWith(`${CLOSING_OPTION}'`);
      expect(command).not.toContain('reply ready and wait for your brief');
    }
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain('watch: started');
  });

  test('records the CLI each seat was launched with', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    await runUp(FILE, io, sources({}, made));
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.cli).toBe('claude-code');
    expect(seats['deepseek-acme']?.cli).toBe('claude-code');
    expect(seats['deepseek-acme-2']?.cli).toBe('claude-code');
  });

  test('a permission prompt closes that workspace and leaves the others', async () => {
    await approve();
    const made = world((_pane, label) => (label === 'claude opus 5.5' ? PERMISSION : IDLE));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: permission; its workspace was closed without input');
    expect(made.closes).toEqual(['w1']);
    expect(made.renames).not.toContain('claude-coordinator-acme');
    expect(made.renames).toContain('deepseek-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
    expect(seats['deepseek-acme']?.stage).toBe('ready');
  });

  test('a trust dialog closes that workspace without an answer and leaves the seat out', async () => {
    await approve();
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude opus 5.5' ? trust : IDLE));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: trust question');
    expect(made.closes).toEqual(['w1']);
    expect(made.renames).not.toContain('claude-coordinator-acme');
    expect(made.runs.some((run) => run.command.includes('Yes'))).toBe(false);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
  });

  test('a seat that never idles stays launched', async () => {
    await approve();
    const made = world('');
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: timed out waiting for its idle prompt; left at launched');
    expect(made.closes).toEqual([]);
    expect(made.renames).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
  });

  test('a recorded pane that is gone is launched again', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: { 'claude-coordinator-acme': { stage: 'launched', pane: 'w9:p1', workspace: 'w9' } },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    const io = testIo(root, { kind: 'owner' });
    await runUp(FILE, io, sources({ sessionState: () => 'running', workspaces: () => [] }, made));
    expect(made.starts).toBe(0);
    expect(made.creates).toContain('claude opus 5.5');
    expect(made.runs.some((run) => run.pane === 'w9:p1')).toBe(false);
    expect(made.runs.some((run) => run.pane === 'w1:p1')).toBe(true);
  });

  test('a ready seat is left alone, and a launched one with a live pane is finished', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w8:p1', workspace: 'w8' },
              'deepseek-acme': { stage: 'launched', pane: 'w7:p1', workspace: 'w7' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, true);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [agent('claude-coordinator-acme', 'w8:p1'), agent('deepseek-acme', 'w7:p1')],
          workspaces: () => [{ id: 'w8' }, { id: 'w7' }],
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('skip claude-coordinator-acme: already ready; left as it is');
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(made.creates).not.toContain('deepseek flash v4.1');
    expect(made.renames).toContain('deepseek-acme');
    expect(made.renames).not.toContain('claude-coordinator-acme');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['deepseek-acme']?.stage).toBe('ready');
  });

  test('a stopped session is refused and no server is started', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'stopped' }, made));
    expect(code).toBe(1);
    expect(io.err).toContain('herdr session delete acme-web');
    expect(made.starts).toBe(0);
    expect(made.creates).toEqual([]);
  });

  // The refusal names the session's own name, whatever `--session` says: the owner copies the line.
  test("a stopped session's refusal prints the exact herdr command with its name", async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--session', 'beta-team', ...FILE], io, sources(
      { sessionState: (session) => (session === 'beta-team' ? 'stopped' : 'absent') },
      made,
    ));
    expect(code).toBe(1);
    expect(io.err).toBe('team up: session beta-team is stopped; clear it with `herdr session delete beta-team`\n');
    expect(made.starts).toBe(0);
  });

  // Whatever sits in a `stopped` field — a shape `down` once wrote, or anything else — changes
  // nothing: `up` never reads it and never deletes a session.
  test.each([
    ['the shape a stop once wrote', { at: NOW.toISOString(), by: 'owner' }],
    ['a boolean', true],
    ['a string', 'stopped'],
  ] as [string, unknown][])('a state file whose stopped field is %s refuses the same', async (_what, stopped) => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({ format: 1, sessions: { 'acme-web': { seats: {}, worktrees: {}, stopped } } }),
    );
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'stopped' }, made));
    expect(code).toBe(1);
    expect(io.err).toBe('team up: session acme-web is stopped; clear it with `herdr session delete acme-web`\n');
    // The field is left exactly as it was, on disk.
    const filed = JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8')) as {
      sessions: Record<string, { stopped?: unknown }>;
    };
    expect(filed.sessions['acme-web']?.stopped).toEqual(stopped);
  });

  test("the approval's ceilings are enforced, not the file's limits", async () => {
    await approve();
    const path = join(store(), 'approval.json');
    const body = JSON.parse(readFileSync(path, 'utf8')) as { ceilings: { seats: number } };
    body.ceilings.seats = 1;
    writeFileSync(path, JSON.stringify(body));
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(made.creates.filter((label) => label !== 'watchdog')).toEqual(['claude opus 5.5']);
    expect(io.out).toContain('the approval allows 1 seats; 2 would be running');
  });

  test('a machine past the file refuses before any server starts', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          machine: () => ({ loadPerCore: 9, memoryFree: 80, diskFree: 1e12, swapFree: 1e12, swapUsed: 0 }),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.err).toContain('the load is 9.0 per core, above 3');
    expect(made.starts).toBe(0);
  });

  test('each start limit refuses with its figure, and a dry run prints that refusal', async () => {
    await approve();
    const cases: { machine: Machine; text: string }[] = [
      { machine: { ...fine, memoryFree: 10 }, text: 'free memory is 10%, below 25%' },
      { machine: { ...fine, swapFree: 1.1e9 }, text: 'free swap is 1.1 GB, below 2.0 GB' },
      { machine: { ...fine, diskFree: 5e9 }, text: 'free disk is 5.0 GB, below 10.0 GB' },
    ];
    for (const item of cases) {
      const dry = testIo(root, { kind: 'owner' });
      await runUp(['--dry-run', ...FILE], dry, sources({ machine: () => item.machine, sessionRunning: () => false }, world()));
      expect(dry.out).toContain(`! up would refuse: ${item.text}`);
      const made = world();
      const io = testIo(root, { kind: 'owner' });
      expect(await runUp(FILE, io, sources({ machine: () => item.machine }, made))).toBe(1);
      expect(io.err).toContain(item.text);
      expect(made.starts).toBe(0);
    }
  });

  test('a reading that crosses mid-up stops before the next seat', async () => {
    await approve();
    let reads = 0;
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      machine: () => {
        reads += 1;
        return { ...fine, swapUsed: reads >= 4 ? 3e9 : 1e9 };
      },
    }, made));
    expect(code).toBe(1);
    expect(made.creates).toContain('claude opus 5.5');
    expect(made.creates).not.toContain('deepseek flash v4.1');
    expect(io.out).toContain('deepseek-acme: swap grew by 2.0 GB in 10 minutes, above 1.0 GB');
  });

  test('readings inside every limit launch the seats', async () => {
    await approve();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, io, sources({ machine: () => fine }, made))).toBe(0);
    expect(made.creates).toEqual(['claude opus 5.5', 'deepseek flash v4.1', 'deepseek flash v4.1-2', 'watchdog']);
  });

  test("a doctor miss refuses, and the watch's missing heartbeat does not", async () => {
    await approve();
    const missingIo = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run', ...FILE], missingIo, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctor({ version: () => null }),
    });
    expect(missingIo.out).toContain('! up would refuse: install `claude`: it is not on the PATH');

    const heartbeatIo = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run', ...FILE], heartbeatIo, {
      sessionRunning: () => true,
      agents: () => [],
      home,
      doctor: doctor({ sessionRunning: () => true }),
    });
    expect(heartbeatIo.out).not.toContain('! up would refuse');
    expect(heartbeatIo.out).not.toContain('no watch has run');
  });
});

describe('team down, live', () => {
  function seat(status = 'idle'): HerdrAgent {
    return agent('deepseek-acme', 'w3:p1', status);
  }

  function harness(screen: Screen, status = 'idle') {
    const typed: string[] = [];
    const entered: string[] = [];
    const closed: string[] = [];
    const killed: number[] = [];
    const stopped: string[] = [];
    const deleted: string[] = [];
    let clock = NOW.getTime();
    let gone = false;
    let current = status;
    let onSleep = () => {};
    // What the pane shows after a typing: the box with the typed text, as the CLI renders it.
    let box: string | undefined;
    let clearFails = false;
    const launch: DownLaunch = {
      typeText(_session, _pane, text) {
        typed.push(text);
        box = claudeBox(text);
        return true;
      },
      pressEnter() {
        entered.push('enter');
        gone = true;
        return true;
      },
      agentPanes: () => (gone ? [] : ['w3:p1']),
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      stopSession(session) {
        stopped.push(session);
        return true;
      },
      deleteSession(session) {
        deleted.push(session);
        return !clearFails;
      },
      kill(pid) {
        killed.push(pid);
        return true;
      },
      sleep: async (ms) => {
        clock += ms;
        onSleep();
      },
      now: () => new Date(clock),
    };
    // Herdr's answer once the stop has run: a session `down` stopped is no longer running.
    const sourcesOf = (overrides: Partial<DownSources> = {}): DownSources => ({
      sessionRunning: () => stopped.length === 0,
      agents: () => [seat(current)],
      alive: () => false,
      screen: () => screen,
      screenText: () => box,
      status: () => current,
      foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
      now: () => new Date(clock),
      sleep: launch.sleep,
      launch,
      ...overrides,
    });
    return {
      typed,
      entered,
      closed,
      killed,
      stopped,
      deleted,
      launch,
      sourcesOf,
      setStatus: (value: string) => {
        current = value;
      },
      onSleep: (hook: () => void) => {
        onSleep = hook;
      },
      failClear: () => {
        clearFails = true;
      },
    };
  }

  test('an agent that exits between the text and the Enter is not sent the Enter', async () => {
    const run = harness({ kind: 'idle' });
    let live = true;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      live = false;
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => (live ? ['claude'] : ['zsh']) }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(io.out).toContain('deepseek-acme: no live agent in its pane; its exit was not typed\n');
  });

  test('a pane with no live agent is not typed into', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'] }));
    expect(code).toBe(1);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: no live agent in its pane; its exit was not typed\n');
  });

  test('types the exit only when the screen is idle, then closes the workspace', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('clears the session it stopped, in the same run, and says so in one line', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.deleted).toEqual(['acme-web']);
    expect(io.out).toContain('session acme-web: stopped and cleared\n');
  });

  test('down then up needs no step in between', async () => {
    await approve();
    const run = harness({ kind: 'idle' });
    const owner = testIo(root, { kind: 'owner' });
    expect(await runDown(FILE, owner, run.sourcesOf())).toBe(0);
    expect(run.deleted).toEqual(['acme-web']);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({ sessionState: () => 'absent' }, made));
    expect(code).toBe(0);
    expect(made.starts).toBe(1);
    expect(io.out).not.toContain('herdr session delete');
  });

  test('a session herdr still reports running after the stop is not cleared', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ sessionRunning: () => true }));
    expect(code).toBe(0);
    expect(run.stopped).toEqual(['acme-web']);
    expect(run.deleted).toEqual([]);
    expect(io.out).toContain('session acme-web: stopped; it did not clear, run `herdr session delete acme-web`\n');
  });

  test('a clear that fails names the herdr command and still exits 0', async () => {
    const run = harness({ kind: 'idle' });
    run.failClear();
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.deleted).toEqual(['acme-web']);
    expect(io.out).toContain('session acme-web: stopped; it did not clear, run `herdr session delete acme-web`\n');
  });

  test('a seat left running clears nothing', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
    expect(io.out).not.toContain('cleared');
  });

  test("a seat's call is refused before anything is stopped or cleared", async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'seat', name: 'deepseek-acme', pane: 'w3:p1' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
  });

  test('holds Enter when the status turns working after the text', async () => {
    const run = harness({ kind: 'idle' });
    let looks = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(
      FILE,
      io,
      run.sourcesOf({
        status: () => {
          looks += 1;
          return looks === 1 ? 'idle' : 'working';
        },
      }),
    );
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not typed; left as it is\n');
  });

  test('a pinned Codex permission after the exit text gets no Enter', async () => {
    const pinnedRaw = readFileSync(new URL('../fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    const pinned = readScreen('codex', pinnedRaw);
    const run = harness({ kind: 'idle' });
    let screen: Screen = { kind: 'idle' };
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      screen = pinned;
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      screen: () => screen,
      // The pane really shows the dialog after the typing: the box read-back refuses it.
      screenText: () => pinnedRaw,
      agents: () => [{ ...agent('codex-acme', 'w3:p1', 'idle'), agent: 'codex' }],
    }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('codex-acme: its exit was not typed; left as it is\n');
  });

  test('a rule-looking row after the exit text gets no Enter', async () => {
    // The pane draws `/exit` and then one more indented row of forty ─ inside the box, before
    // its closing rule. The pane draws content rows at the text's own column, and the closing
    // rule is the window's last rule row, an unbroken run of ─ from the pane's first column
    // (unsent-typed-ansi.txt): the extra row is content the exit text does not have, so the
    // box does not hold it. The exit is typed, and not sent.
    const run = harness({ kind: 'idle' });
    let shown: string | undefined;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      shown = claudeBox([text, '─'.repeat(40)].join('\n'));
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ screenText: () => shown }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not typed; left as it is\n');
  });

  test('a prompt-glyph continuation row after the exit text gets no Enter', async () => {
    // The round-6 reproduction on the exit path: the box holds the person's own text and then
    // a continuation row carrying only the prompt glyph, and the pane appends `/exit` after
    // the glyph. The input row is the box's first row under its opening rule, so the box does
    // not read back as the exit text — read by glyph it did, and the exit and the person's
    // text were submitted together. The exit is typed, and not sent.
    const run = harness({ kind: 'idle' });
    let shown: string | undefined;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      shown = claudeBox(`person text\n❯ ${text}`);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ screenText: () => shown }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: its exit was not typed; left as it is\n');
  });

  test('a second glyph row at the prompt column after the exit text gets no Enter', async () => {
    // The 0.2.1 boundary on the exit path, in Codex's shape: the pane holds the person's own
    // text and then a row carrying the prompt at the input row's own column, and the read-back
    // before 0.2.1 took that lowest row for the input — the exit text read back, the Enter went
    // in, and the person's text was submitted with it. No capture draws a person's continuation
    // at the prompt column (Codex's are indented two columns), so the shape fails closed: the
    // exit is typed, and not sent.
    const codexIdle = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    const run = harness({ kind: 'idle' });
    let shown: string | undefined;
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      shown = codexIdle.replace('› Ask Codex to do anything', `› person text\n› ${text}`);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      screenText: () => shown,
      agents: () => [{ ...agent('codex-acme', 'w3:p1', 'idle'), agent: 'codex' }],
    }));
    expect(code).toBe(1);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('codex-acme: its exit was not typed; left as it is\n');
  });

  test.each(['close-short', 'close-long', 'open-short'] as const)(
    'an Antigravity box whose two rules differ in width gets no exit Enter (%s)',
    async (shape) => {
      // The round-7 reproduction on the exit path: the seat is Antigravity's, and the pane
      // shows a two-rule frame whose rules disagree in width — a frame that cannot be
      // established. Without the width check the window read unsent after the typing, the
      // read-back held, and the Enter was sent with it. The exit is typed, and not sent.
      writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace(
        /  - role: implementer\n    name: deepseek-acme[\s\S]*?count: 2[^\n]*\n/,
        ['  - role: implementer', '    name: gemini-acme', '    cli: antigravity', '    vendor: google',
          '    model: Gemini Flash', '    version: "3.8"', '    launch: agy'].join('\n') + '\n',
      ));
      const run = harness({ kind: 'idle' });
      let shown: string | undefined;
      run.launch.typeText = (_session, _pane, text) => {
        run.typed.push(text);
        shown = agyMismatchedFrame(shape, text);
        return true;
      };
      const io = testIo(root, { kind: 'owner' });
      const code = await runDown(FILE, io, run.sourcesOf({
        screenText: () => shown,
        agents: () => [agent('gemini-acme', 'w3:p1', 'idle')],
      }));
      expect(code).toBe(1);
      expect(run.typed).toEqual(['/exit']);
      expect(run.entered).toEqual([]);
      expect(run.closed).toEqual([]);
      expect(io.out).toContain('gemini-acme: its exit was not typed; left as it is\n');
    });

  test('does not type into a permission prompt', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('is blocked at a prompt');
  });

  test.each(['idle', 'working'])('a captured Codex permission blocks down when herdr says %s', async (status) => {
    const captured = readFileSync(new URL('../fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const run = harness(readScreen('codex', captured), status);
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      agents: () => [{ ...agent('codex-acme', 'w3:p1', status), agent: 'codex' }],
    }));
    expect(code).toBe(0);
    expect(io.out).toContain('is blocked at a prompt');
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
  });

  test('a seat that does not leave is left as it is', async () => {
    const run = harness({ kind: 'idle' });
    run.launch.agentPanes = () => ['w3:p1'];
    run.launch.pressEnter = () => true;
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(1);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(run.deleted).toEqual([]);
    expect(io.out).toContain('deepseek-acme: timed out leaving its pane; left as it is');
    expect(io.out).toContain('session acme-web: not stopped, something was left in it');
  });

  test('the owner can abandon a blocked seat without typing', async () => {
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--abandon', ...FILE], io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.closed).toEqual(['w3']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('--wait holds a working seat until it is free', async () => {
    const run = harness({ kind: 'idle' }, 'working');
    let waits = 0;
    run.onSleep(() => {
      waits++;
      run.setStatus('idle');
    });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(['--wait', ...FILE], io, run.sourcesOf());
    expect(waits).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
  });

  // The file renamed the seat after `up` launched it: the state still records it, under the CLI
  // it was launched with, and `down` stops it under its old name.
  function renamedSeat(cli?: string) {
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace('name: deepseek-acme', 'name: relay-acme'));
    const recorded = cli === undefined ? { stage: 'ready' } : { stage: 'ready', cli };
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: { 'acme-web': { seats: { 'deepseek-acme': recorded }, worktrees: {} } },
      }),
    );
  }

  test('stops a seat the file renamed, under the CLI the state records', async () => {
    renamedSeat('claude-code');
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual(['/exit']);
    expect(run.entered).toEqual(['enter']);
    expect(run.closed).toEqual(['w3']);
    expect(run.stopped).toEqual(['acme-web']);
    expect(io.out).toContain('deepseek-acme: stopped\n');
  });

  test('a renamed seat with no live agent in its pane is not typed into', async () => {
    renamedSeat('claude-code');
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ foreground: () => ['zsh'] }));
    expect(code).toBe(1);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(io.out).toContain('deepseek-acme: no live agent in its pane; its exit was not typed\n');
  });

  test('a renamed seat at a permission prompt is not typed into', async () => {
    renamedSeat('claude-code');
    const run = harness({ kind: 'permission' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('deepseek-acme: is blocked at a prompt');
  });

  test('a seat whose state predates the CLI record is left running, with what to run', async () => {
    renamedSeat();
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf());
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain(
      "deepseek-acme: the state doesn't say which CLI it runs, so it can't be asked to exit; " +
        'left running (`team down --abandon` closes it without typing)',
    );
    expect(io.out).toContain('session acme-web: not stopped, 1 agent left in it');
  });

  test('an agent neither the file nor the state records is left entirely alone', async () => {
    const run = harness({ kind: 'idle' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({ agents: () => [agent('stranger', 'w9:p1')] }));
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain('session acme-web: not stopped, 1 agent left in it');
  });
});

const SCRATCH = 'team-test-up';
const TRUSTED = join(homedir(), 'team-test-up-trusted');
const TRUSTED_SHOWN = '~/team-test-up-trusted';

// Read only. A test never writes ~/.claude.json; the owner trusts the fixed folder by hand.
function folderTrusted(): boolean {
  let text: string;
  try {
    text = readFileSync(join(homedir(), '.claude.json'), 'utf8');
  } catch {
    return false;
  }
  let projects: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;
  try {
    projects = (JSON.parse(text) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return false;
  }
  const keys = new Set<string>([TRUSTED]);
  try {
    keys.add(realpathSync(TRUSTED));
  } catch {
    // The folder is not there yet. The stored key is the path the owner opens.
  }
  for (const key of keys) {
    if (projects[key]?.hasTrustDialogAccepted === true) return true;
  }
  return false;
}

async function requireMachine(): Promise<void> {
  const uptime = execFileSync('uptime', { encoding: 'utf8' });
  const load = Number(/load averages?: ([\d.]+)/.exec(uptime)?.[1] ?? '99');
  if (!(load < 60)) throw new Error(`load is ${load}; not starting a session`);
  const pressure = execFileSync('memory_pressure', { encoding: 'utf8' });
  const memory = parseMemoryPressure(pressure);
  if (memory === null || memory < 25) throw new Error(`free memory is ${memory}%; not starting a session`);
  const readSwap = () => parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }));
  const first = readSwap();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  const second = readSwap();
  if (!first || !second) throw new Error('swap could not be read; not starting a session');
  if (second.used > first.used) {
    throw new Error(`swap used grew from ${first.used} to ${second.used}; not starting a session`);
  }
  console.log(`gate load ${load} memory ${memory}% swap used ${first.used} then ${second.used}`);
}

function cheapFile(): string {
  const deepseek = [
    '  - role: implementer',
    '    name: deepseek-acme',
    "    cli: claude-code           # DeepSeek's model, run by Claude Code",
    '    vendor: deepseek',
    '    model: DeepSeek Flash',
    '    version: "V4.1"',
    '    display: DeepSeek V4.1 Flash',
    '    launch: team-deepseek',
    '    count: 2                   # deepseek-acme, deepseek-acme-2',
    '',
  ].join('\n');
  const cheap = EXAMPLE.replace('session: acme-web', `session: ${SCRATCH}`)
    .replace('model: Claude Opus', 'model: Claude Haiku')
    .replace('version: "5.5"', 'version: "4.5"')
    .replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-haiku-4-5-20251001')
    .replace('  load_start: 3.0', '  load_start: 60')
    .replace(
      "  disk_min: 10GB               # free on the project's volume; both refuse and report",
      "  disk_min: 10GB               # free on the project's volume; both refuse and report\n  swap_free_min: 1MB",
    )
    .replace(deepseek, '');
  if (cheap.includes('deepseek-acme') || !cheap.includes('claude-haiku-4-5-20251001')) {
    throw new Error('the scratch file is not the one cheap claude-code seat');
  }
  return cheap;
}

function stopScratch() {
  const left = sessionState(SCRATCH);
  if (left !== 'running' && left !== 'stopped') return;
  try {
    execFileSync('herdr', ['session', 'stop', SCRATCH], { stdio: 'ignore' });
  } catch {
    // already stopped
  }
  try {
    execFileSync('herdr', ['session', 'delete', SCRATCH], { stdio: 'ignore' });
  } catch {
    // the test reports the failure above; the session is named so it can be cleared by hand
  }
}

describe('scratch session', () => {
  // Opt-in: CI has no herdr. Never team-test, which is another seat's session.
  // A fresh folder shows Claude's trust question. up leaves the seat out and types nothing.
  test.skipIf(process.env.TEAM_LIVE_UP !== '1')(
    'a fresh folder leaves the seat out: trust question',
    async () => {
      await requireMachine();
      const before = sessionState(SCRATCH);
      if (before !== 'absent') throw new Error(`session ${SCRATCH} is ${before}; not touching it`);

      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'team-scratch-')));
      const project = join(scratch, 'acme-web');
      const scratchHome = join(scratch, 'home');
      mkdirSync(join(project, '.agents'), { recursive: true });
      mkdirSync(scratchHome);
      writeFileSync(join(project, '.agents/team.yaml'), cheapFile());
      const file = ['--file', join(project, '.agents/team.yaml')];
      const owner = testIo(project, { kind: 'owner' });
      try {
        expect(await runApprove(file, owner, { ask: async () => '3', now: () => new Date(), home: scratchHome })).toBe(0);
        const doctor = upReal.doctor ? { ...upReal.doctor, home: scratchHome } : undefined;
        const upCode = await runUp(file, owner, { ...upReal, home: scratchHome, doctor });
        expect(upCode).toBe(1);
        if (!owner.out.includes('left out: trust question')) {
          throw new Error(owner.out.split('\n').slice(-20).join('\n'));
        }
        await runDown(file, owner, downReal);
      } finally {
        stopScratch();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    240_000,
  );

  // The idle path runs only in a folder the owner has already trusted. This test never writes that trust.
  const live = process.env.TEAM_LIVE_UP === '1';
  if (live && !folderTrusted()) {
    test.skip(
      `trust ${TRUSTED_SHOWN} once by hand: accept the workspace trust dialog in Claude; this test only reads ~/.claude.json`,
      () => {},
    );
  } else {
    test.skipIf(!live)(
      'launches one cheap seat in the trusted folder and stops it',
      async () => {
        await requireMachine();
        const before = sessionState(SCRATCH);
        if (before !== 'absent') throw new Error(`session ${SCRATCH} is ${before}; not touching it`);
        const scratchHome = mkdtempSync(join(tmpdir(), 'team-trusted-home-'));
        const agentsDir = join(TRUSTED, '.agents');
        const createdAgents = !existsSync(agentsDir);
        const owner = testIo(TRUSTED, { kind: 'owner' });
        try {
          mkdirSync(agentsDir, { recursive: true });
          writeFileSync(join(agentsDir, 'team.yaml'), cheapFile());
          const file = ['--file', join(agentsDir, 'team.yaml')];
          expect(await runApprove(file, owner, { ask: async () => '3', now: () => new Date(), home: scratchHome })).toBe(0);
          const doctor = upReal.doctor ? { ...upReal.doctor, home: scratchHome } : undefined;
          const upCode = await runUp(file, owner, { ...upReal, home: scratchHome, doctor });
          expect(upCode).toBe(0);
          const downCode = await runDown(file, owner, downReal);
          if (downCode !== 0) throw new Error(`down left this:\n${owner.out}\n${owner.err}`);
        } finally {
          stopScratch();
          rmSync(scratchHome, { recursive: true, force: true });
          if (createdAgents) rmSync(agentsDir, { recursive: true, force: true });
        }
      },
      240_000,
    );
  }
});
