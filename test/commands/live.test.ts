import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/commands/approve.ts';
import { realSources as downReal, runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { realSources as upReal, runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { sessionState, setHerdrRun, workspacePanes, type HerdrAgent } from '../../src/herdr.ts';
import { readApproval, storePath, writeApproval } from '../../src/store/store.ts';
import { readState } from '../../src/state.ts';
import { parseMemoryPressure, parseSwapUsage, type Machine } from '../../src/watch/machine.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { agyMismatchedFrame, claudeBox, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapFree: 8e9, swapUsed: 1e9 };
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

// The captured Codex home names Terra 5.6. The example file says GPT Sol 6, so a launch test
// that should get past the model check shows the file's model on that same status row.
function fileModel(text: string): string {
  return text.replaceAll('GPT-5.6-Terra', 'GPT-6-Sol');
}
const PERMISSION = 'Do you want to proceed?\n1. Yes\n';
const CLOSING_MESSAGE = 'These are standing rules, not a task: reply ready and wait for your brief.';
const CLOSING_OPTION = 'These are standing rules, not a task.';

let base: string;
let root: string;
let home: string;

function makeExample(basePath: string, rootPath: string, text: string = EXAMPLE): string {
  return text.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-live-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
});

afterEach(() => {
  setHerdrRun(null);
  rmSync(base, { recursive: true, force: true });
});

const store = () => storePath('acme-web', root, home);

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', now: () => NOW, home });
  expect(code).toBe(0);
}

function agent(name: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
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
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
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
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'gpt sol 6' ? fileModel(capture('idle')) : IDLE));
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
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => label === 'gpt sol 6'
      ? fileModel(capture(outcome === 'trust' || outcome === 'startup' ? outcome : 'idle')) : IDLE);
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
      // The reading, the close included, names the seat on the terminal and in the log.
      const line =
        outcome === 'trust'
          ? 'codex-acme: trust question; its workspace was closed without an answer and the seat left out'
          : 'codex-acme: question; its workspace was closed without input and the seat left out';
      expect(io.out).toContain(`${line}\n`);
      expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(line);
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
    writeFileSync(path, makeExample(base, root, EXAMPLE.replace(/  - role: implementer\n    name: codex-acme[\s\S]*?stopped: true\n/, `${gemini}\n`)));
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
    // The reading, the close included, is what the log keeps.
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(
      'claude-coordinator-acme: permission; its workspace was closed without input and the seat left out',
    );
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
    // The line names the seat, the reading and the close; the same goes to the log.
    const line = 'claude-coordinator-acme: trust question; its workspace was closed without an answer and the seat left out';
    expect(io.out).toContain(`${line}\n`);
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(line);
    expect(made.closes).toEqual(['w1']);
    expect(made.renames).not.toContain('claude-coordinator-acme');
    expect(made.runs.some((run) => run.command.includes('Yes'))).toBe(false);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toBeUndefined();
  });

  // A close that fails is not a close: no line may claim one, and the seat keeps its state.
  test.each([
    ['trust', 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n', 'trust question'],
    ['permission', PERMISSION, 'permission'],
    ['question', 'Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n', 'question'],
  ] as const)('a %s reading whose close fails leaves the seat as it is', async (_reading, screen, reading) => {
    await approve();
    const made = world((_pane, label) => (label === 'claude opus 5.5' ? screen : IDLE));
    const closed: string[] = [];
    made.launch.closeWorkspace = (_session, workspace) => {
      closed.push(workspace);
      return false;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    // The line names the seat, the reading and the failed close; the same goes to the log.
    const line = `claude-coordinator-acme: ${reading}; its workspace did not close; left as it is`;
    expect(io.out).toContain(`${line}\n`);
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(line);
    // It tried; nothing else claims the workspace was closed.
    expect(closed).toEqual(['w1']);
    expect(io.out).not.toContain('was closed');
    // The seat's state is kept as it is: a later `up` finds it at launched, on its pane.
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']).toMatchObject({ stage: 'launched', pane: 'w1:p1', workspace: 'w1' });
  });

  test('a seat that never idles stays launched, with the reading and the pane lines', async () => {
    await approve();
    // The screen of the capture this report is built from: the launch line's own echo, the
    // shell's failure, and the prompt back.
    const shown = "❯ zsh ../tools/launcher.sh\nzsh: can't open input file: ../tools/launcher.sh\n~ ❯\n";
    const made = world(shown);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain(
      'claude-coordinator-acme: timed out after 90 s waiting for its idle prompt; ' +
        'the screen last read unknown; left at launched\n',
    );
    expect(io.out).toContain('  | ❯ zsh ../tools/launcher.sh\n');
    expect(io.out).toContain("  | zsh: can't open input file: ../tools/launcher.sh\n");
    expect(io.out).toContain('  run `team up` again to resume it\n');
    expect(made.closes).toEqual([]);
    expect(made.renames).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
    // The log keeps the reading only: the pane's text is said on the terminal, never written.
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log).toContain('timed out after 90 s waiting for its idle prompt; the screen last read unknown');
    expect(log).not.toContain('zsh');
  });

  test('a launch command that ended at once is reported at once', async () => {
    await approve();
    const made = world();
    made.launch.shellBack = () => true;
    // Each pane shows the line that was run into it, the shell's failure, and the prompt back.
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      // The echo is cut to its first line, as the pane shows it when the command wraps.
      return command ? `❯ ${command.split('\n')[0]}\nzsh: command not found\n~ ❯\n` : read(session, pane);
    };
    let naps = 0;
    const napping = made.launch.sleep;
    made.launch.sleep = async (ms) => { naps++; return napping(ms); };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain(
      'claude-coordinator-acme: its pane has been back at its shell for 6 s and shows no CLI prompt; left at launched\n',
    );
    // Three pauses per ended seat — the three full polls the stretch takes — not the 90-second
    // deadline's worth of them.
    expect(naps).toBeLessThanOrEqual(9);
    expect(io.out).toContain('  | ❯ AGENT_UNATTENDED=1 claude --model claude-opus-5-5 ');
    expect(io.out).toContain('  | zsh: command not found\n');
    expect(io.out).toContain('  run `team up` again to resume it\n');
    expect(io.out).not.toContain('timed out');
    // Left at launched, workspace kept: a later `up` resumes the seat.
    expect(made.closes).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
  });

  test('a shell-back reading with no echo of the launch line is waited out', async () => {
    await approve();
    // The shell is back on every poll, but the screen never holds the launch line's echo: the
    // line may not have arrived, or the screen may be a fresh shell. That is not evidence the
    // launch ran and ended, so the wait goes to the deadline and the reading is a timeout.
    const made = world('restarted\n~ ❯\n');
    made.launch.shellBack = () => true;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: timed out after 90 s waiting for its idle prompt');
    expect(io.out).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
  });

  test('the reviewed probe: two shell-back readings a poll apart, then idle, is not an end', async () => {
    await approve();
    // The review's own sample sequence at 7ede9fb4: unknown with the shell back at t=0 and
    // t=2000, then idle at t=4000, the pane still drawing and the launch line's echo nowhere on
    // it. The wait used to call the second reading an end, at clock 2000 and two reads in; it
    // must instead go on, so the CLI that was still starting is seen when it arrives.
    const made = world();
    const polls = new Map<string, number>();
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      if (pane !== 'w1:p1') return read(session, pane);
      const n = (polls.get(pane) ?? 0) + 1;
      polls.set(pane, n);
      return n <= 2 ? 'startup still drawing\n' : IDLE;
    };
    made.launch.shellBack = (_session, pane) => pane === 'w1:p1' && (polls.get(pane) ?? 0) <= 2;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).not.toContain('shows no CLI prompt');
    // The CLI arrived, so the seat is the state's ready — not left at launched by an early end.
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
  });

  test('one shell-back reading, even with the echo, never ends the wait', async () => {
    await approve();
    // The mutation the review found uncaught: letting a single shell-back sample end the wait.
    // One reading is not a stretch — a pane can show its shell for a moment between the launch
    // and the CLI's first draw — so the sample is only a start, and the deadline is the report.
    const made = world();
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      return command ? `❯ ${command.split('\n')[0]}\nstartup still drawing\n` : read(session, pane);
    };
    const seen = new Map<string, number>();
    made.launch.shellBack = (_session, pane) => {
      const n = (seen.get(pane) ?? 0) + 1;
      seen.set(pane, n);
      return n === 1;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: timed out after 90 s waiting for its idle prompt');
    expect(io.out).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
  });

  test('the wrapper that draws its CLI on the fourth poll is not reported as ended', async () => {
    await approve();
    // The reviewer's slow-start probe: a wrapper keeps the shell in front for three polls and
    // the CLI draws on the fourth. The shell-back reading must hold through the fourth reading —
    // three full poll intervals — before an end is said; two readings ended it at the second.
    const made = world();
    const commands = new Map<string, string>();
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => {
      commands.set(pane, command);
      return run(session, pane, command);
    };
    const polls = new Map<string, number>();
    made.launch.shellBack = (_session, pane) => {
      const n = (polls.get(pane) ?? 0) + 1;
      polls.set(pane, n);
      return n <= 3;
    };
    const read = made.launch.paneText.bind(made.launch);
    made.launch.paneText = (session, pane) => {
      const command = commands.get(pane);
      if (!command) return read(session, pane);
      return (polls.get(pane) ?? 0) <= 3 ? `❯ ${command.split('\n')[0]}\nstartup still drawing\n` : IDLE;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme: ready\n');
    expect(io.out).not.toContain('shows no CLI prompt');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('ready');
  });

  test('a shell-back reading that clears is not an end, and a herdr that cannot say waits', async () => {
    await approve();
    const made = world('');
    const seen = new Map<string, number>();
    // The first poll after the launch may still report the shell — captured on herdr 0.7.1 —
    // and later polls report nothing readable at all.
    made.launch.shellBack = (_session, pane) => {
      const n = (seen.get(pane) ?? 0) + 1;
      seen.set(pane, n);
      return n === 1 ? true : null;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: timed out after 90 s waiting for its idle prompt');
    expect(io.out).not.toContain('shows no CLI prompt');
    expect(made.closes).toEqual([]);
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.stage).toBe('launched');
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

  // The incident's session, ready to resume: the Codex seat at `named` with its pane and workspace
  // recorded and its box showing `screen`, the coordinator ready. The file puts the DeepSeek pair out.
  function incident(screen: string): World {
    writeFileSync(
      join(root, '.agents/team.yaml'),
      makeExample(
        base,
        root,
        EXAMPLE.replace('    stopped: true\n', '')
          .replace(
            '    count: 2                   # deepseek-acme, deepseek-acme-2\n',
            '    count: 2                   # deepseek-acme, deepseek-acme-2\n    stopped: true\n',
          ),
      ),
    );
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(namedState()));
    const made = world();
    made.session = 'running';
    made.seed('w2:p1', screen, true);
    return made;
  }

  function namedState() {
    return {
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'claude-coordinator-acme': { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
            'codex-acme': { stage: 'named', pane: 'w2:p1', workspace: 'w2', start_cwd: '.' },
          },
          worktrees: {},
          watch: { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
        },
      },
    };
  }

  function resumed(made: World): UpSources {
    return sources(
      {
        sessionState: () => 'running',
        agents: () => [agent('claude-coordinator-acme', 'w1:p1'), agent('codex-acme', 'w2:p1')],
        workspaces: () => [{ id: 'w1' }, { id: 'w2' }],
        alive: () => true,
        watchCommand: () => 'team watch',
      },
      made,
    );
  }

  const captureCodex = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');

  test('the incident: a named seat whose box holds an unsent message is left as it is on the next up', async () => {
    const made = incident(captureCodex('unsent'));
    await approve();
    const sent: string[] = [];
    made.launch.agentStatus = () => 'idle';
    made.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    made.launch.pressEnter = () => { sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(made));
    // The box reads `unsent`: nothing is typed, no key is sent, no workspace is closed, and the
    // seat's state is left byte for byte as it was.
    expect(code).toBe(1);
    expect(io.out).toContain('codex-acme: its rules were not delivered; left at named');
    expect(sent).toEqual([]);
    expect(made.closes).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8'))).toEqual(namedState());
  });

  test('a named seat whose box is empty and idle is delivered to on the next up', async () => {
    const made = incident(captureCodex('idle'));
    await approve();
    const calls: string[] = [];
    let typedPane = '';
    let typed = '';
    let pasted = false;
    let status = 'idle';
    const read = made.launch.paneText;
    // The pane with the paste rendered: the idle frame's placeholder row replaced by the typed
    // message, later lines at the prompt's own column, as the fixtures README describes.
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return captureCodex('idle').replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.foreground = (_session, pane) => { calls.push(`foreground ${pane}`); return ['codex']; };
    made.launch.agentStatus = (_session, pane) => { calls.push(`agentStatus ${pane}`); return pane === typedPane ? status : 'idle'; };
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText ${pane}`);
      return pane === typedPane ? (pasted ? boxed() : captureCodex('working')) : read(session, pane);
    };
    made.launch.typeText = (_session, pane, text) => { calls.push(`typeText ${pane}`); typedPane = pane; typed = text; pasted = true; return true; };
    made.launch.pressEnter = (_session, pane) => { calls.push(`pressEnter ${pane}`); pasted = false; status = 'working'; return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(made));
    expect(code).toBe(0);
    expect(io.out).toContain('codex-acme: ready');
    expect(made.closes).toEqual([]);
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'];
    expect(seat).toMatchObject({ stage: 'ready', rules: 'message', pane: 'w2:p1', workspace: 'w2' });
    // Main's order of host calls: the pane's program, its status and its box are read first, the
    // message is typed into the empty box and read back, one key is sent, then the closing readings.
    expect(calls).toEqual([
      'foreground w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'typeText w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'foreground w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
      'pressEnter w2:p1',
      'agentStatus w2:p1',
      'paneText w2:p1',
    ]);
  });

  test('a named seat whose box holds exactly what team would type now is left as it is', async () => {
    const made = incident(captureCodex('idle'));
    await approve();
    // The message team would type now, taken from team itself: the empty box is delivered to once.
    let typed = '';
    let typedPane = '';
    let pasted = false;
    let status = 'idle';
    const read = made.launch.paneText;
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return captureCodex('idle').replace('› Ask Codex to do anything', [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n'));
    };
    made.launch.agentStatus = (_session, pane) => (pane === typedPane ? status : 'idle');
    made.launch.typeText = (_session, pane, text) => { typedPane = pane; typed = text; pasted = true; return true; };
    made.launch.pressEnter = () => { pasted = false; status = 'working'; return true; };
    made.launch.paneText = (session, pane) => (pane === typedPane ? (pasted ? boxed() : captureCodex('working')) : read(session, pane));
    expect(await runUp(FILE, testIo(root, { kind: 'owner' }), resumed(made))).toBe(0);
    expect(typed).not.toBe('');

    // The seat is at `named` again, its box holding exactly the message team just typed.
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(namedState()));
    const again = world();
    again.session = 'running';
    again.seed('w2:p1', boxed(), true);
    const calls: string[] = [];
    const sent: string[] = [];
    again.launch.foreground = (_session, pane) => { calls.push(`foreground ${pane}`); return ['codex']; };
    again.launch.agentStatus = (_session, pane) => { calls.push(`agentStatus ${pane}`); return 'idle'; };
    const reread = again.launch.paneText;
    again.launch.paneText = (session, pane) => { calls.push(`paneText ${pane}`); return reread(session, pane); };
    again.launch.typeText = (_session, _pane, text) => { sent.push(text); return true; };
    again.launch.pressEnter = () => { sent.push('Enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, resumed(again));
    expect(code).toBe(1);
    expect(io.out).toContain('codex-acme: its rules were not delivered; left at named');
    expect(sent).toEqual([]);
    expect(again.closes).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8'))).toEqual(namedState());
    expect(calls).toEqual(['foreground w2:p1', 'agentStatus w2:p1', 'paneText w2:p1']);
  });

  test('a resumed seat is checked where its pane runs, not where the file would put it', async () => {
    // The file's deepseek seats work in worktrees and would start in the lobby; their recorded
    // panes run in the project root, where `../tools/x.sh` is a file. Only the state's `start_cwd`
    // says so, and the reading names that folder — the same line, a different folder, a different end.
    writeFileSync(
      join(root, '.agents/team.yaml'),
      EXAMPLE
        .replace('launch: team-deepseek\n    count: 2', 'launch: zsh ../tools/x.sh\n    count: 2')
        .replace(/trust:.*\n(?:  - .*\n)+/, `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n`),
    );
    await approve();
    mkdirSync(join(base, 'tools'), { recursive: true });
    writeFileSync(join(base, 'tools', 'x.sh'), 'echo hi\n');
    const lobby = join(base, 'worktrees', 'acme-web', '.lobby');
    const run = async (start_cwd?: string) => {
      const recorded = (pane: string, workspace: string) => ({
        stage: 'launched',
        pane,
        workspace,
        ...(start_cwd ? { start_cwd } : {}),
      });
      writeFileSync(
        join(root, '.agents/team.state.json'),
        JSON.stringify({
          format: 1,
          sessions: {
            'acme-web': {
              seats: { 'deepseek-acme': recorded('w7:p1', 'w7'), 'deepseek-acme-2': recorded('w6:p1', 'w6') },
              worktrees: {},
            },
          },
        }),
      );
      const made = world();
      made.session = 'running';
      made.seed('w7:p1', IDLE, false);
      made.seed('w6:p1', IDLE, false);
      const io = testIo(root, { kind: 'owner' });
      const code = await runUp(
        FILE,
        io,
        sources(
          {
            sessionState: () => 'running',
            agents: () => [],
            workspaces: () => [{ id: 'w7' }, { id: 'w6' }],
            doctor: doctor(),
          },
          made,
        ),
      );
      return { code, out: io.out, err: io.err };
    };
    // The root is where the panes run: the line resolves, the seats are resumed, nothing is refused.
    const atRoot = await run(root);
    expect(atRoot.code).toBe(0);
    expect(atRoot.out).toContain('deepseek-acme: ready');
    expect(atRoot.out).not.toContain('would refuse');
    expect(atRoot.err).not.toContain('not checked');
    // The lobby — where the file's own seats would start — is where it does not resolve: refused at
    // the recorded folder, with the file that is at the project root named for the line to use.
    const atLobby = await run(lobby);
    expect(atLobby.code).toBe(1);
    expect(atLobby.out).toContain(
      'deepseek-acme: refused: its launch line runs `../tools/x.sh`, not found from its start folder ' +
        `${lobby}; the same file is at \`${join(base, 'tools', 'x.sh')}\` from the project root — write that path`,
    );
  });

  test('a resumed seat whose state records no start folder is not checked at all', async () => {
    writeFileSync(
      join(root, '.agents/team.yaml'),
      EXAMPLE
        .replace('launch: team-deepseek\n    count: 2', 'launch: zsh ../tools/x.sh\n    count: 2')
        .replace(/trust:.*\n(?:  - .*\n)+/, `trust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${join(base, 'worktrees')}\n`),
    );
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'deepseek-acme': { stage: 'launched', pane: 'w7:p1', workspace: 'w7' },
              'deepseek-acme-2': { stage: 'launched', pane: 'w6:p1', workspace: 'w6' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, false);
    made.seed('w6:p1', IDLE, false);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          agents: () => [],
          workspaces: () => [{ id: 'w7' }, { id: 'w6' }],
          doctor: doctor(),
        },
        made,
      ),
    );
    // The file's folder is not where those panes are, so the lines are not read against either:
    // they are said to be unchecked, and the seats resume as they always did.
    expect(code).toBe(0);
    expect(io.err).toContain(
      '  note deepseek-acme: its launch line was not checked: the seat is resumed and its state records no start folder\n',
    );
    expect(io.out).toContain('deepseek-acme: ready');
    expect(io.out).not.toContain('would refuse');
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
    // The approval fixed fewer seats than the file allows: the record is written again, signed,
    // with its own ceilings — as the owner's earlier approval of a smaller team reads today.
    const record = readApproval(store());
    if (!record) throw new Error('approval');
    writeApproval(store(), {
      approval: { ...record.approval, ceilings: { ...record.approval.ceilings, seats: 1 } },
      file: record.file,
    }, [], home);
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

// A restored session: herdr lists the names, and the processes behind them are not the ones team
// launched. `up` closes each such workspace with no key and no text, clears the launch state, and
// launches the seat fresh; a seat still holding its recorded process is skipped as ready.
describe('team up, a session that was restored', () => {
  test('four seats: one same, one gone, one replaced, one whose pane is missing', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace('stopped: true\n', 'parked: true\n'));
    await approve();
    // Every seat was ready before the power went. codex-acme is the one whose recorded process is
    // still in its pane; the coordinator's runs no CLI; deepseek-acme's runs another CLI; and
    // deepseek-acme-2's pane is gone from herdr altogether.
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
              'codex-acme': { stage: 'ready', pane: 'w92:p1', workspace: 'w92', launched: { shell: 410, cli: [411] } },
              'deepseek-acme': { stage: 'ready', pane: 'w93:p1', workspace: 'w93', launched: { shell: 430, cli: [431] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'w94:p1', workspace: 'w94', launched: { shell: 440, cli: [441] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    // The readings as herdr gives them: pids only. w92 is the recorded process; w91's shell is in
    // front with no CLI; w93's shell is the recorded one and a stranger's CLI is in front; w94
    // can't be read at all.
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w91:p1') return { shell: 420, foreground: [420] };
      if (pane === 'w92:p1') return { shell: 410, foreground: [410, 411] };
      if (pane === 'w93:p1') return { shell: 430, foreground: [500] };
      if (pane === 'w94:p1') return null;
      // A pane this run made: the CLI it has just launched.
      return { shell: 700, foreground: [700, 701] };
    };
    // The repair re-reads herdr immediately before each close: the agent list, the process
    // reading again, and — for a replaced pane — its screen. w93's pane shows an idle screen,
    // so the replaced seat is closed only because its screen does not read working.
    const agents = [
      agent('claude-coordinator-acme', 'w91:p1', 'idle'),
      agent('codex-acme', 'w92:p1', 'idle', 'codex'),
      agent('deepseek-acme', 'w93:p1', 'idle'),
    ];
    made.launch.agents = () => { calls.push('agents'); return agents; };
    // The ordered host calls: the workspaces closed, the workspaces made, the lines run.
    const calls: string[] = [];
    const keys: string[] = [];
    const close = made.launch.closeWorkspace.bind(made.launch);
    made.launch.closeWorkspace = (session, workspace) => { calls.push(`close ${workspace}`); return close(session, workspace); };
    const create = made.launch.createWorkspace.bind(made.launch);
    made.launch.createWorkspace = (session, cwd, label) => {
      const madeWs = create(session, cwd, label);
      calls.push(`create ${label} ${madeWs?.pane ?? '-'}`);
      return madeWs;
    };
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => { calls.push(`run ${pane}`); return run(session, pane, command); };
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => { calls.push(`process ${pane}`); return read(session, pane); };
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText ${pane}`);
      return pane === 'w93:p1' ? IDLE : text(session, pane);
    };
    made.launch.typeText = (_session, pane, text) => { keys.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { keys.push(`enter ${pane}`); return true; };

    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [{ id: 'w91' }, { id: 'w92' }, { id: 'w93' }],
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme', 'w93:p1', 'idle'),
          ],
          doctor: doctor(),
        },
        made,
      ),
    );

    expect(code).toBe(0);
    // Each broken seat's workspace is closed before its own fresh launch, and the pane that holds
    // the wrong process is never typed or run into.
    expect(made.closes).toEqual(['w91', 'w93']);
    // The reads of item 1 stand directly before each close, with nothing between: the agent
    // list, the pane and process read; the screen only for the replaced seat.
    const before = (at: string, n: number) => calls.slice(0, calls.indexOf(at)).slice(-n);
    expect(before('close w91', 2)).toEqual(['agents', 'process w91:p1']);
    expect(before('close w93', 3)).toEqual(['agents', 'process w93:p1', 'paneText w93:p1']);
    expect(calls.indexOf('close w91')).toBeLessThan(calls.indexOf('run w1:p1'));
    expect(calls.indexOf('close w93')).toBeLessThan(calls.indexOf('run w2:p1'));
    expect(keys).toEqual([]);
    expect(made.runs.filter(({ pane }) => ['w91:p1', 'w92:p1', 'w93:p1', 'w94:p1'].includes(pane))).toEqual([]);
    // Both fresh launches carry their rules; the fresh panes read the new identity back.
    expect(made.runs.find(({ pane }) => pane === 'w1:p1')?.command).toContain('--append-system-prompt');
    expect(made.runs.find(({ pane }) => pane === 'w1:p1')?.command).toContain('Agent: Claude Opus 5.5 · project coordinator');
    expect(made.runs.find(({ pane }) => pane === 'w2:p1')?.command).toContain('DeepSeek V4.1 Flash');
    // The report: the same seat skipped, the two relaunches said in one line each, the missing
    // pane launched the way it always was.
    expect(io.out).toContain('skip codex-acme: already ready; left as it is');
    expect(io.out).toContain('claude-coordinator-acme: its pane held no CLI; closed without input and launched again\n');
    expect(io.out).toContain('deepseek-acme: its pane held a process team did not launch; closed without input and launched again\n');
    expect(io.out).toContain('deepseek-acme-2: ready\n');
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['codex-acme']).toMatchObject({ stage: 'ready', pane: 'w92:p1', launched: { shell: 410, cli: [411] } });
    expect(seats['claude-coordinator-acme']).toMatchObject({ stage: 'ready', pane: 'w1:p1', launched: { shell: 700, cli: [701] } });
    expect(seats['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w2:p1', launched: { shell: 700, cli: [701] } });
    expect(seats['deepseek-acme-2']).toMatchObject({ stage: 'ready', pane: 'w3:p1', launched: { shell: 700, cli: [701] } });
  });

  test('a workspace that does not close leaves the seat out with a line', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace('stopped: true\n', 'parked: true\n'));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'w91:p1', workspace: 'w91', launched: { shell: 420, cli: [421] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.launch.processInfo = () => ({ shell: 420, foreground: [420] });
    made.launch.agents = () => [agent('claude-coordinator-acme', 'w91:p1', 'idle')];
    made.launch.closeWorkspace = () => false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [{ id: 'w91' }],
          agents: () => [agent('claude-coordinator-acme', 'w91:p1', 'idle')],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its workspace did not close; left as it is\n');
    expect(made.creates).not.toContain('claude opus 5.5');
    // Nothing was cleared: the seat's record still names the pane whose process is not the seat's.
    expect((readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {})['claude-coordinator-acme'])
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  // The four recorded seats the close-path tests start from: each with its pane, workspace and
  // identity, and every reading `same`, so only the seat a test breaks takes the repair path.
  const restoredState = {
    'claude-coordinator-acme': { pane: 'w91:p1', workspace: 'w91', shell: 420, cli: 421 },
    'codex-acme': { pane: 'w92:p1', workspace: 'w92', shell: 410, cli: 411 },
    'deepseek-acme': { pane: 'w93:p1', workspace: 'w93', shell: 430, cli: 431 },
    'deepseek-acme-2': { pane: 'w94:p1', workspace: 'w94', shell: 440, cli: 441 },
  } as const;
  const restoredList = () =>
    Object.entries(restoredState).map(([name, seat]) => agent(name, seat.pane, 'idle', name === 'codex-acme' ? 'codex' : 'claude'));
  function restored(): World {
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: Object.fromEntries(
              Object.entries(restoredState).map(([name, seat]) => [
                name,
                { stage: 'ready', pane: seat.pane, workspace: seat.workspace, launched: { shell: seat.shell, cli: [seat.cli] } },
              ]),
            ),
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    for (const seat of Object.values(restoredState)) made.seed(seat.pane, IDLE, true);
    // The readings as herdr gives them now: every recorded process is still in its pane.
    made.launch.processInfo = (_session, pane) => {
      const seat = Object.values(restoredState).find((item) => item.pane === pane);
      return seat ? { shell: seat.shell, foreground: [seat.shell, seat.cli] } : { shell: 700, foreground: [700, 701] };
    };
    made.launch.agents = restoredList;
    return made;
  }
  const restoredSources = (): Partial<UpSources> => ({
    sessionState: () => 'running',
    workspaces: () => Object.values(restoredState).map((seat) => ({ id: seat.workspace })),
    agents: restoredList,
    doctor: doctor(),
  });
  // The file the four-seat test writes: codex-acme parked back in, so only grok-acme stays stopped.
  const restoredFile = () => writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace('stopped: true\n', 'parked: true\n'));
  const seatState = (name: string) => (readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {})[name];

  test('the owner restarts the CLI between the plan and the close: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    // The plan's reading says the coordinator's pane runs no CLI; by the close herdr reads the
    // recorded process again — the owner restarted it between the two. `same` is not an error:
    // the seat is skipped as ready, and nothing is closed or launched for it.
    const read = made.launch.processInfo!;
    let seen = 0;
    made.launch.processInfo = (session, pane) => {
      if (pane !== 'w91:p1') return read(session, pane);
      seen += 1;
      return seen === 1 ? { shell: 420, foreground: [420] } : { shell: 420, foreground: [420, 421] };
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(0);
    expect(io.out).toContain("claude-coordinator-acme: its pane is the seat's again; left as it is\n");
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('herdr no longer names the seat on its recorded pane: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    // The name is listed, on a pane team did not record: a reused id, or another agent renamed.
    made.launch.agents = () => [{ ...agent('claude-coordinator-acme', 'w95:p1', 'idle') }, ...restoredList().slice(1)];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: herdr no longer shows this seat on its recorded pane; nothing closed; run team status\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('the recorded workspace now belongs to another pane: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    // herdr knows the seat on its pane, but the pane's workspace is no longer the recorded one:
    // the id was reused for something else, and closing it would close a stranger.
    made.launch.agents = () => [{ ...agent('claude-coordinator-acme', 'w91:p1', 'idle'), workspace: 'w99' }, ...restoredList().slice(1)];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: herdr no longer shows this seat on its recorded pane; nothing closed; run team status\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('the recorded workspace also holds another pane: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    // The recorded workspace holds another pane beside the seat's pane.
    made.seed('w91:p2', '', false);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its workspace holds other panes; nothing closed (close its pane there, then run team up)\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with the right pane id under another workspace id: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: [{ pane_id: 'w91:p1', workspace_id: 'w92' }] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes under no workspace id: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: [{ pane_id: 'w91:p1' }] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with a non-object entry: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: ['w91:p1'] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with a pane id that is not a string: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({ panes: [{ pane_id: 123, workspace_id: 'w91' }] }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with the right entry plus one malformed entry: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    setHerdrRun(() => ({
      panes: [
        { pane_id: 'w91:p1', workspace_id: 'w91' },
        { pane_id: 'w91:p2' },
      ],
    }));
    made.launch.workspacePanes = (_session, ws) => workspacePanes(ws);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('workspacePanes with an empty listing: nothing is closed and line is unreadable', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w91:p1' ? { shell: 420, foreground: [420] } : read(session, pane));
    made.launch.workspacePanes = () => [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('a replaced pane whose screen reads working is never closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w93:p1' ? { shell: 430, foreground: [500] } : read(session, pane));
    // A process team did not launch is in the pane, and it is working: up never closes that,
    // whoever started it.
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w93:p1' ? 'esc to interrupt' : text(session, pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('deepseek-acme: the process in its pane is working; nothing closed (stop it there, or run team remove deepseek-acme)\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('deepseek flash v4.1');
    expect(seatState('deepseek-acme')).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] } });
  });

  test('a replaced pane whose screen reads unsent is never closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    const read = made.launch.processInfo!;
    made.launch.processInfo = (session, pane) => (pane === 'w93:p1' ? { shell: 430, foreground: [500] } : read(session, pane));
    // A process team did not launch is in the pane, and its screen reads unsent:
    // up never closes that, preserving the owner's draft.
    const unsentText = readFileSync(join(import.meta.dir, '../fixtures/claude-code/2.1.289/unsent-typed-ansi.txt'), 'utf8');
    const text = made.launch.paneText;
    made.launch.paneText = (session, pane) => (pane === 'w93:p1' ? unsentText : text(session, pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('deepseek-acme: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove deepseek-acme)\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('deepseek flash v4.1');
    expect(seatState('deepseek-acme')).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] } });
  });

  test('the process reading fails at the close: nothing is closed', async () => {
    restoredFile();
    await approve();
    const made = restored();
    // gone at the plan, unreadable at the close: a failed read is not a free pane.
    const read = made.launch.processInfo!;
    let seen = 0;
    made.launch.processInfo = (session, pane) => {
      if (pane !== 'w91:p1') return read(session, pane);
      seen += 1;
      return seen === 1 ? { shell: 420, foreground: [420] } : null;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources(restoredSources(), made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: its pane could not be read; nothing closed\n');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('claude opus 5.5');
    expect(seatState('claude-coordinator-acme'))
      .toMatchObject({ stage: 'ready', pane: 'w91:p1', launched: { shell: 420, cli: [421] } });
  });

  test('a seat left at named records the process identity too', async () => {
    // Its idle prompt was read — the identity's moment — and the rename went through, but the
    // rules never landed: the record that stands is the named one, and the identity rides in it.
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE.replace('stopped: true\n', 'parked: true\n'));
    await approve();
    const capture = (name: string) => readFileSync(join(import.meta.dir, `../fixtures/codex/0.157.0/${name}.txt`), 'utf8');
    const made = world((_pane, label) => (label === 'gpt sol 6' ? fileModel(capture('idle')) : IDLE));
    made.launch.agentStatus = () => 'idle';
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    // The first message is never typed: the seat stays at named, with the identity recorded.
    made.launch.typeText = () => false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('codex-acme: its rules were not delivered; left at named\n');
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['codex-acme'])
      .toMatchObject({ stage: 'named', launched: { shell: 400, cli: [401] } });
  });

  test('a seat left at launched records the process identity too', async () => {
    // Its idle prompt was read, but the rename never went through: the seat stays at launched,
    // and the record still names the process, so a later read of the pane compares with it.
    await approve();
    const made = world();
    made.launch.processInfo = () => ({ shell: 400, foreground: [400, 401] });
    made.launch.renameAgent = () => false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: was not in the agent list in time; left at launched\n');
    expect(readState(join(root, '.agents')).sessions['acme-web']?.seats['claude-coordinator-acme'])
      .toMatchObject({ stage: 'launched', launched: { shell: 400, cli: [401] } });
  });

  test('a seat with a waiting record and no launched record closes workspace and prints left out', async () => {
    // Both reviews list as a must-fix that up closes the workspace of a seat recorded as
    // waiting at a dialog. That is main's behaviour today and the approved design for an up
    // with no terminal ("for each dialog it closes the workspace without input, prints left out");
    // interactive handling of waiting seats at a terminal is a separate planned change.
    // This test confirms that for a seat with a waiting record and no launched record,
    // up's ordered host calls and output are byte-identical.
    const calls: string[] = [];
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': {
                stage: 'launched',
                pane: 'w1:p1',
                workspace: 'w1',
                waiting: { state: 'waiting-owner', classification: 'trust' },
              },
              'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
              'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3' },
            },
            worktrees: {},
          },
        },
      }),
    );
    const trust = 'Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
    const made = world((_pane, label) => (label === 'claude opus 5.5' ? trust : IDLE));
    made.session = 'running';
    made.launch.agentPanes = () => ['w1:p1', 'w2:p1', 'w3:p1'];
    const listed = [
      agent('claude-coordinator-acme', 'w1:p1', 'idle'),
      agent('deepseek-acme', 'w2:p1', 'idle'),
      agent('deepseek-acme-2', 'w3:p1', 'idle'),
    ];
    made.launch.agents = () => listed;
    const origClose = made.launch.closeWorkspace;
    made.launch.closeWorkspace = (session, ws) => {
      calls.push(`close:${ws}`);
      return origClose(session, ws);
    };
    const origPaneText = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push(`paneText:${pane}`);
      return pane === 'w1:p1' ? trust : origPaneText(session, pane);
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      agents: () => listed,
      workspaces: () => [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
    }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: trust question; its workspace was closed without an answer and the seat left out\n');
    expect(calls).toEqual(['paneText:w1:p1', 'close:w1']);
    expect(made.closes).toEqual(['w1']);
  });
});

  test.each([
    ['another model', 'gpt-sol-idle', 'drift'],
    ['the file\'s model', 'idle', 'equal'],
    ['a family the grammar does not know', 'unknown-family', 'refused'],
    ['an output line where the footer was', 'spoof', 'refused'],
    ['a full status row where the footer was', 'full-row', 'drift'],
    ['a row whose version is not a token', 'unreadable', 'unchecked'],
  ] as const)('cursor launch, screen shows %s', async (_label, screen, expectCase) => {
    const path = join(root, '.agents/team.yaml');
    const cursorSeat = [
      '  - role: implementer',
      '    name: cursor-acme',
      '    cli: cursor',
      '    vendor: xai',
      '    model: Grok',
      '    version: "4.7"',
      '    launch: cursor-agent',
      '    mode: shared',
    ].join('\n');
    writeFileSync(path, makeExample(base, root, EXAMPLE
      .replace(
        '    count: 2                   # deepseek-acme, deepseek-acme-2\n',
        '    count: 2\n    stopped: true\n',
      )
      .replace(/  - role: implementer\n    name: codex-acme[\s\S]*?stopped: true\n/, `${cursorSeat}\n`)));
    await approve();
    const home = readFileSync(join(import.meta.dir, '../fixtures/cursor/2026.10.01/idle.txt'), 'utf8');
    const footer = '  Grok 4.7 256K High                 Run Everything';
    // Muse Spark is a family the closed grammar does not know, and `  GPT-5.6 Sol 272K High`
    // without `Run Everything` is output shaped like a row: both screens read `unknown`, the
    // idle wait times out, and the seat is never renamed. A row that keeps every token —
    // `Run Everything` included — is a real row by every test the screen offers, so it is
    // accepted and the model check reads it. `  Grok 4x …` is a row whose version is not a
    // token: the screen reads idle, the model check finds nothing to read, and the seat
    // continues with a line that says so.
    const shown = screen === 'idle'
      ? home
      : screen === 'gpt-sol-idle'
        ? readFileSync(join(import.meta.dir, '../fixtures/cursor/2026.10.01/gpt-sol-idle.txt'), 'utf8')
        : screen === 'unknown-family'
          ? home.replace(footer, '  Muse Spark 1.3                    Run Everything')
          : screen === 'unreadable'
            ? home.replace(footer, '  Grok 4x 256K High                 Run Everything')
            : screen === 'spoof'
              ? home.replace(footer, '  GPT-5.6 Sol 272K High')
              : home.replace(footer, '  GPT-5.6 Sol 272K High              Run Everything');
    const made = world((_pane, label) => (label === 'grok 4.7' ? shown : IDLE));
    const sent: string[] = [];
    let cursorPane = '';
    let pasted = false;
    let typed = '';
    let status = 'idle';
    // In the unreadable case the cursor pane renders the typed rules the way the delivery tests'
    // panes do — the typed text's rows in the composer's box — and reports the agent working
    // after the Enter, so the delivery completes like any other seat's.
    const boxed = () => {
      const [first = '', ...rest] = typed.split('\n');
      return shown.replace('  → Plan, search, build anything', [`  → ${first}`, ...rest.map((line) => `    ${line}`)].join('\n'));
    };
    made.launch.agentStatus = () => status;
    // The order the run's host calls are made in, recorded so the unreadable case can pin it.
    const calls: string[] = [];
    const makeWorkspace = made.launch.createWorkspace;
    made.launch.createWorkspace = (session, cwd, label) => { calls.push(`create:${label}`); return makeWorkspace(session, cwd, label); };
    const runInPane = made.launch.paneRun;
    made.launch.paneRun = (session, pane, command) => { calls.push(`paneRun:${command.split(' ')[0]}`); return runInPane(session, pane, command); };
    const readPane = made.launch.paneText;
    made.launch.paneText = (session, pane) => {
      calls.push('paneText');
      return pane === cursorPane && pasted ? boxed() : readPane(session, pane);
    };
    const panesOf = made.launch.agentPanes;
    made.launch.agentPanes = (session) => { calls.push('agentPanes'); return panesOf(session); };
    const renameSeat = made.launch.renameAgent;
    made.launch.renameAgent = (session, pane, name) => { calls.push('renameAgent'); return renameSeat(session, pane, name); };
    made.launch.typeText = (_session, pane, text) => {
      sent.push(text); calls.push('typeText');
      if (screen === 'unreadable') { cursorPane = pane; typed = text; pasted = true; }
      return true;
    };
    made.launch.pressEnter = () => {
      sent.push('Enter'); calls.push('pressEnter');
      if (screen === 'unreadable') { status = 'working'; pasted = false; }
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const say = io.stdout;
    io.stdout = (text: string) => { calls.push(text.includes('not checked') ? 'not-checked' : 'report'); say(text); };
    const code = await runUp(FILE, io, sources({}, made));
    const seat = readState(join(root, '.agents')).sessions['acme-web']?.seats['cursor-acme'];
    if (expectCase === 'drift') {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(made.renames).not.toContain('cursor-acme');
      expect(seat?.stage).toBe('launched');
      expect(io.out).toContain(
        'cursor-acme: runs GPT Sol 5.6; the file says Grok 4.7; left at launched, not named. Add --model grok-4.7-high to its launch, or correct the file\'s model and version and run `team approve`\n',
      );
      return;
    }
    if (expectCase === 'refused') {
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(made.renames).not.toContain('cursor-acme');
      expect(seat?.stage).toBe('launched');
      expect(io.out).toContain('cursor-acme: timed out after 90 s waiting for its idle prompt; the screen last read unknown; left at launched\n');
      return;
    }
    if (expectCase === 'unchecked') {
      // The screen read idle and the model check found nothing to read: the seat is not left
      // unnamed — it is renamed and given its rules like any other seat, and the report says the
      // model was not checked.
      expect(code).toBe(0);
      expect(seat).toMatchObject({ stage: 'ready', rules: 'message' });
      expect(made.renames).toContain('cursor-acme');
      expect(sent.length).toBeGreaterThan(0);
      expect(io.out).toContain("cursor-acme: its screen doesn't show a model this version knows; not checked\n");
      // The seat's own calls, in order: the wait's read and the model check's read of the
      // screen, the report that no model was checked, the rename, then the delivery — read,
      // typed, read back, entered — and the ready report after it. The not-checked report comes
      // before the rename, so the seat is named only after the check has had its say.
      const from = calls.indexOf('create:grok 4.7');
      expect(calls.slice(from, from + 14)).toEqual([
        'create:grok 4.7',
        'paneRun:AGENT_UNATTENDED=1',
        'paneText',
        'paneText',
        'not-checked',
        'agentPanes',
        'renameAgent',
        'paneText',
        'typeText',
        'paneText',
        'paneText',
        'pressEnter',
        'paneText',
        'report',
      ]);
      return;
    }
    expect(made.renames).toContain('cursor-acme');
    expect(sent.length).toBeGreaterThan(0);
    expect(io.out).not.toContain('left at launched, not named');
    expect(io.out).not.toContain('not checked');
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
    // The close op is `down`'s own purpose, announced by its plan; the line and the log name the seat and the fact.
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain('deepseek-acme: stopped');
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

  // The refused shapes on the exit path, on both CLIs: the read-back before the Enter must
  // fail closed when the window starts inside the box with a visible continuation above the
  // prompt, and when a second prompt row is pressed against the one above it with no blank
  // row between them (the person's own row would otherwise be submitted with the exit). The
  // transcript's echo above the blank frame is not refused — it is `idle`, as main reads it.
  const CURSOR_DS = EXAMPLE.replace(
    `  - role: implementer
    name: deepseek-acme
    cli: claude-code           # DeepSeek's model, run by Claude Code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek`,
    `  - role: implementer
    name: deepseek-acme
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent`,
  );

  test.each([
    ['codex', 'codex-acme', '  person-owned visible continuation\n›'],
    ['codex', 'codex-acme', '› person text\n›'],
    ['cursor', 'deepseek-acme', '    person-owned visible continuation\n  →'],
    ['cursor', 'deepseek-acme', '  → person text\n  →'],
  ] as const)('an exit into a %s box that is not the one the captures draw gets no Enter (%j)', async (cli, seat, shape) => {
    // The seat's CLI is read from the team file by name — Codex's seat is codex-acme's, the
    // cursor case rewrites deepseek-acme's — so each case reads the shape through its own CLI.
    // The pane shows the shape the captures do not draw: the read is not idle, the seat is
    // left running, and nothing is typed or sent.
    const idle = readFileSync(new URL(`../fixtures/${cli}/${cli === 'codex' ? '0.157.0' : '2026.10.01'}/idle.txt`, import.meta.url), 'utf8');
    const placeholder = cli === 'codex' ? '› Ask Codex to do anything' : '  → Plan, search, build anything';
    if (cli === 'cursor') writeFileSync(join(root, '.agents/team.yaml'), CURSOR_DS);
    const pane = idle.replace(placeholder, shape);
    const run = harness({ kind: 'idle' });
    run.launch.typeText = (_session, _pane, text) => {
      run.typed.push(text);
      return true;
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runDown(FILE, io, run.sourcesOf({
      screen: () => readScreen(cli, pane),
      screenText: () => pane,
      agents: () => [{ ...agent(seat, 'w3:p1', 'idle'), agent: cli }],
    }));
    // The seat is reported left running and the run ends the way any unrecognised screen
    // does — nothing was typed, so nothing failed.
    expect(code).toBe(0);
    expect(run.typed).toEqual([]);
    expect(run.entered).toEqual([]);
    expect(run.closed).toEqual([]);
    expect(run.stopped).toEqual([]);
    expect(io.out).toContain(`${seat}: shows a screen the profile does not recognise; left running\n`);
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
        if (!owner.out.includes('trust question; its workspace was closed without an answer and the seat left out')) {
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
