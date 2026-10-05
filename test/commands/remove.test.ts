import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { rulesFilePath, writeRulesFile } from '../../src/launch/rules-file.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { readScreen, type Screen } from '../../src/watch/screen.ts';
import { testIo, claudeBox } from '../helpers.ts';

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  # stays above lead
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const owner = { kind: 'owner' as const };
const lead = { kind: 'seat' as const, name: 'lead', pane: 'w0:p1' };

let dir: string;
let file: string;
let clock: number;

function world(screen: Screen = { kind: 'idle' }, status = 'idle'): {
  sources: RemoveSources;
  typed: string[];
  closed: string[];
  agents: HerdrAgent[];
  running: boolean[];
} {
  const typed: string[] = [];
  const closed: string[] = [];
  let sent = false;
  // What the pane shows after a typing: the box with the typed text, as the CLI renders it.
  let box: string | undefined;
  const agents: HerdrAgent[] = [];
  const running: boolean[] = [];
  clock = 0;
  const launch: DownLaunch = {
    typeText: (_session, _pane, text) => { typed.push(text); box = claudeBox(text); return true; },
    pressEnter: () => { sent = true; return true; },
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  const sources: RemoveSources = {
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => screen,
    screenText: () => box,
    status: () => status,
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    launch,
    foreground: () => (running[0] === true ? ['claude'] : sent || running[0] === false ? [] : ['claude']),
  };
  return { sources, typed, closed, agents, running };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-remove-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, FILE);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('team remove', () => {
  test('a free seat is exited, then taken out, and the comment above the next seat stays', async () => {
    const made = world();
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(0);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual(['w1']);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('name: worker');
    expect(text).toContain('# stays above lead');
    expect(text).toContain('name: lead');
  });

  test('a pane with no live agent is not typed into', async () => {
    const made = world();
    made.running.push(false);
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('no live agent in its pane; its exit was not typed');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a pinned Codex permission after the exit text gets no Enter', async () => {
    const pinnedRaw = readFileSync(new URL('../fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    const pinned = readScreen('codex', pinnedRaw);
    const made = world();
    let screen: Screen = { kind: 'idle' };
    made.sources.screen = () => screen;
    // The pane really shows the dialog after the typing: the box read-back refuses it.
    made.sources.screenText = () => pinnedRaw;
    const entered: string[] = [];
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      screen = pinned;
      return true;
    };
    launch.pressEnter = () => {
      entered.push('enter');
      return true;
    };
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(entered).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('worker: its exit was not typed; left as it is');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a box that holds someone else\'s text gets no Enter', async () => {
    const made = world();
    made.sources.screenText = () => claudeBox('half a sentence, not this exit');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('worker: its exit was not typed; left as it is');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a prompt-glyph continuation row after the exit text gets no Enter', async () => {
    // The round-6 reproduction on the remove path: the box holds the person's own text and
    // then a continuation row carrying only the prompt glyph, and the pane appends `/exit`
    // after the glyph. The input row is the box's first row under its opening rule, so the box
    // does not read back as the exit text — read by glyph it did, and the exit and the
    // person's text were submitted together. The exit is typed, and not sent.
    const made = world();
    let box: string | undefined;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      box = claudeBox(`person text\n❯ ${text}`);
      return true;
    };
    made.sources.screenText = () => box;
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('worker: its exit was not typed; left as it is');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a second glyph row at the prompt column after the exit text gets no Enter', async () => {
    // The 0.2.1 boundary on the remove path, in Codex's shape (the worker seat below is
    // Codex's): the pane holds the person's own text and then a row carrying the prompt at the
    // input row's own column, and the read-back before 0.2.1 took that lowest row for the
    // input — the exit text read back, the Enter went in, and the person's text was submitted
    // with it. No capture draws a person's continuation at the prompt column (Codex's are
    // indented two columns), so the shape fails closed: the exit is typed, and not sent.
    const codexIdle = readFileSync(new URL('../fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
    writeFileSync(file, FILE.replace(
      `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
      `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high`,
    ));
    const made = world();
    let shown: string | undefined;
    let gone = false;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      shown = codexIdle.replace('› Ask Codex to do anything', `› person text\n› ${text}`);
      return true;
    };
    launch.pressEnter = () => {
      gone = true;
      return true;
    };
    made.sources.screenText = () => shown;
    made.sources.foreground = () => (gone ? [] : ['codex']);
    made.agents.push({ name: 'worker', agent: 'codex', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual(['/exit']);
    expect(made.closed).toEqual([]);
    expect(io.out).toContain('worker: its exit was not typed; left as it is');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test.each([
    ['codex', '  person-owned visible continuation\n›'],
    ['codex', '› person text\n›'],
    ['cursor', '    person-owned visible continuation\n  →'],
    ['cursor', '  → person text\n  →'],
  ] as const)('a %s box that is not the one the captures draw after the exit text gets no Enter (%j)', async (cli, shape) => {
    // The refused shapes on the remove path, on both CLIs: a window starting inside the box
    // with a visible continuation above the prompt, and a second prompt row pressed against
    // the one above it with no blank row between them. The pane read is not free, so the seat
    // is left running and nothing is typed: the exit never reaches the pane. The transcript's
    // echo above the blank frame is not refused — it is `idle`, as main reads it.
    const idle = readFileSync(new URL(`../fixtures/${cli}/${cli === 'codex' ? '0.157.0' : '2026.10.01'}/idle.txt`, import.meta.url), 'utf8');
    const placeholder = cli === 'codex' ? '› Ask Codex to do anything' : '  → Plan, search, build anything';
    writeFileSync(file, FILE.replace(
      `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
      cli === 'codex'
        ? `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high`
        : `  - role: implementer
    name: worker
    label: worker
    cli: cursor
    vendor: xai
    model: Grok
    version: "4.7"
    launch: cursor-agent`,
    ));
    const pane = idle.replace(placeholder, shape);
    const made = world();
    let gone = false;
    const launch = made.sources.launch;
    if (!launch) throw new Error('fixture');
    launch.typeText = (_session, _pane, text) => {
      made.typed.push(text);
      return true;
    };
    launch.pressEnter = () => {
      gone = true;
      return true;
    };
    made.sources.screen = () => readScreen(cli, pane);
    made.sources.screenText = () => pane;
    made.sources.foreground = () => (gone ? [] : [cli === 'codex' ? 'codex' : 'cursor-agent']);
    made.agents.push({ name: 'worker', agent: cli, pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual([]);
    expect(io.err).toContain('team remove: worker shows a screen the profile does not recognise');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a seat that is not running is taken out without typing', async () => {
    const made = world();
    const io = testIo(dir, lead);
    expect(await runRemove(['worker'], io, made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
  });

  test('--keep leaves the seat stopped', async () => {
    const made = world();
    expect(await runRemove(['worker', '--keep', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('name: worker');
    expect(text).toContain('stopped: true');
    expect(text).toContain('name: lead');
  });

  test('remove --keep by the coordinator leaves a hand-edited launch line as drift', async () => {
    const parsed = validateTeamFile(FILE);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, dir, dir), {
      approval: approvalOf(parsed.team, dir),
      file: FILE,
    }, parsed.team.seats, dir);
    const edited = FILE.replace('launch: claude --model claude-opus-5-5', 'launch: claude --model claude-opus-5-5 --yolo');
    writeFileSync(file, edited);
    const made = world();
    made.sources.home = dir;
    expect(await runRemove(['worker', '--keep'], testIo(dir, lead), made.sources)).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    expect(readFileSync(file, 'utf8')).toContain('--yolo');
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(approvalDifferences(after.team, dir, dir)).toEqual(['seat worker changed']);
  });

  test('remove --keep does not approve a hand-written parked line', async () => {
    const parsed = validateTeamFile(FILE);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, dir, dir), {
      approval: approvalOf(parsed.team, dir),
      file: FILE,
    }, parsed.team.seats, dir);
    writeFileSync(file, FILE.replace('    name: worker', '    name: worker\n    parked: true'));
    const made = world();
    made.sources.home = dir;
    expect(await runRemove(['worker', '--keep'], testIo(dir, lead), made.sources)).toBe(0);
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(after.team.seats.find((seat) => seat.name === 'worker')?.parked).toBe(true);
    expect(approvalDifferences(after.team, dir, dir)).toEqual(['seat worker changed']);
  });

  test('--keep by the owner leaves no drift, and a seat-made parked line is drift', async () => {
    const parsed = validateTeamFile(FILE);
    if (!parsed.ok) throw new Error('fixture');
    writeApproval(storePath(parsed.team.project, dir, dir), {
      approval: approvalOf(parsed.team, dir),
      file: FILE,
    }, parsed.team.seats, dir);
    const parked = FILE.replace('    name: worker', '    name: worker\n    parked: true');
    const hand = validateTeamFile(parked);
    if (!hand.ok) throw new Error('parked fixture');
    expect(approvalDifferences(hand.team, dir, dir)).toEqual(['seat worker changed']);

    const made = world();
    made.sources.home = dir;
    expect(await runRemove(['worker', '--keep', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    const after = validateTeamFile(readFileSync(file, 'utf8'));
    if (!after.ok) throw new Error('written file');
    expect(approvalDifferences(after.team, dir, dir)).toEqual([]);
  });

  test('working, blocked, unknown and unsent change nothing', async () => {
    for (const [status, screen, phrase] of [
      ['working', { kind: 'idle' }, 'is working'],
      ['idle', { kind: 'permission' }, 'is blocked'],
      ['idle', { kind: 'unknown' }, 'does not recognise'],
      ['idle', { kind: 'unsent' }, 'unsent'],
    ] as const) {
      writeFileSync(file, FILE);
      const made = world(screen, status);
      made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null });
      const io = testIo(dir, owner);
      expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
      expect(io.err).toContain(phrase);
      expect(made.typed).toEqual([]);
      expect(readFileSync(file, 'utf8')).toContain('name: worker');
    }
  });

  test('a Cursor queue screen is working: the seat is left and nothing is typed', async () => {
    // The screen is a real queue fixture, read through the profile: a turn with
    // follow-ups waiting on it is working, so its pane never gets the exit text.
    const queued = readScreen(
      'cursor',
      readFileSync(new URL('../fixtures/cursor/2026.10.01/follow-up-queue-two.txt', import.meta.url), 'utf8'),
    );
    expect(queued.kind).toBe('working');
    const made = world(queued, 'idle');
    made.agents.push({ name: 'worker', agent: 'cursor', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.err).toContain('is working');
    expect(made.typed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('a time-out leaves the seat and the file', async () => {
    const made = world();
    made.running.push(true);
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    const io = testIo(dir, owner);
    expect(await runRemove(['worker', '--file', file], io, made.sources)).toBe(1);
    expect(io.out).toContain('left as it is');
    expect(made.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('only the owner removes the coordinator, and only the owner abandons', async () => {
    const made = world();
    made.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const seat = testIo(dir, lead);
    expect(await runRemove(['lead'], seat, made.sources)).toBe(1);
    expect(seat.err).toContain('only the owner');
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
    const abandon = testIo(dir, lead);
    expect(await runRemove(['worker', '--abandon'], abandon, world({ kind: 'permission' }, 'idle').sources)).toBe(1);
    expect(abandon.err).toContain('only the owner abandons');
  });

  test('--abandon closes a blocked seat without typing, and taking out the coordinator is refused', async () => {
    const made = world({ kind: 'permission' }, 'idle');
    made.agents.push({ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null });
    expect(await runRemove(['worker', '--abandon', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    expect(made.typed).toEqual([]);
    expect(made.closed).toEqual(['w1']);
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');
    const leadRun = world();
    leadRun.agents.push({ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: 'idle', cwd: null });
    const leadIo = testIo(dir, owner);
    expect(await runRemove(['lead', '--file', file], leadIo, leadRun.sources)).toBe(2);
    expect(leadIo.err).toContain('names no declared seat');
    expect(leadRun.typed).toEqual([]);
    expect(leadRun.closed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('name: lead');
  });

  test('a temporary seat is stopped, its rules file goes with it, and it is not written into the file', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:done.md' } };
    });
    const made = world();
    made.sources.home = dir;
    const rulesFile = rulesFilePath('acme', dir, dir, 'worker-tmp-1');
    writeRulesFile(rulesFile, 'Rules.\n');
    made.agents.push({ name: 'worker-tmp-1', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null });
    expect(await runRemove(['worker-tmp-1', '--file', file], testIo(dir, owner), made.sources)).toBe(0);
    expect(existsSync(rulesFile)).toBe(false);
    expect(readFileSync(file, 'utf8')).not.toContain('tmp');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeUndefined();
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:done.md' } };
    });
    const kept = testIo(dir, owner);
    expect(await runRemove(['worker-tmp-1', '--keep', '--file', file], kept, world().sources)).toBe(1);
    expect(kept.err).toContain('nothing to keep');
  });

  test('a caller who may not change the team changes nothing', async () => {
    const io = testIo(dir, { kind: 'seat', name: 'worker', pane: 'w1:p1' });
    expect(await runRemove(['worker'], io, world().sources)).toBe(1);
    expect(io.err).toContain('only the owner, the coordinator or the operator');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });
});
