// `team usage` — S1: one project's block, resolved from the current folder and read-only. Its
// rows are `status`'s own rows (the same rule and the same table), and the four holds of the
// brief are tested too: nothing is written, no pane or key or CLI session file is read, any
// caller may run it from any folder, and every figure carries its source and its age.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runStatus } from '../src/commands/status.ts';
import { NO_PROJECT, runUsage, USAGE } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');

// The state's readings: a fresh check figure, a status-line figure last seen 40 minutes ago out
// in the open (more than the reserve again, so it is the room last seen, not unknown), and a
// fresh status-line figure inside its reserve. `anthropic` is named by the file and has none.
const READINGS = {
  'openai/session': { account: 'openai', window: 'session', left: 40, used: 60, changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: null, source: 'check', confirmed: true },
  'openai/daily/lead': { account: 'openai', window: 'daily', left: 70, used: 30, changedAt: '2026-10-04T08:20:00Z', resetsAt: null, seat: 'lead', source: 'status_line', confirmed: true },
  'openai/weekly/lead': { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'lead', source: 'status_line', confirmed: true },
};

const BLOCK = [
  'team acme',
  '  anthropic  unknown',
  '  openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh',
  '  openai  daily  left 70%  used 30%  resets unknown  lead  last seen 40m ago  status line (fallback)  stale',
  '  openai  weekly  left 5%  used 95%  resets in 44m  lead  changed 2m ago  status line (fallback)  fresh, inside reserve 20%',
  'no watch is recording for acme',
].join('\n');

let base: string;
let root: string;
let home: string;
let file: string;

/** The team file: trust lists the lobby and the project, the shape a real approved file has,
 *  so the loader's placed checks are satisfied and the file loads. */
function teamText(): string {
  return `format: 1
project: acme
session: acme-web
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [check, status_line]
      check: acme-quota
    anthropic:
      kind: subscription
      reserve: 10%
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

/** The readings the state holds, and the watch record, as the watch would have written them. */
function withState(watch: { pid: number; heartbeat: string } | null = null): void {
  updateState(join(root, '.agents'), (state) => {
    state.budgets = { ...READINGS } as never;
    state.sessions['acme-web'] = { ...emptySession(), ...(watch ? { watch } : {}) } as never;
  });
}

beforeEach(() => {
  // The real path: `/tmp` is a link on this machine, and the loader resolves every folder it
  // checks, so a fixture keeping the `/tmp/...` spelling would fail its own trust walk.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-usage-')));
  home = join(base, 'home');
  root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  file = join(root, '.agents', 'team.yaml');
  const text = teamText();
  writeFileSync(file, text);
  // An approved file in a real store, signed by the key the store writes on first use: the
  // budgets section takes effect only once the owner has approved it.
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
  writeApproval(storePath(checked.team.project, root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, [], home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function usageAt(cwd: string, caller?: Caller, ...argv: string[]) {
  const io = testIo(cwd, caller);
  const code = await runUsage(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

/** The rows under a heading: the two-space lines that follow the line `after`. */
function rowsUnder(text: string, after: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines.slice(lines.indexOf(after) + 1)) {
    if (!line.startsWith('  ')) break;
    out.push(line.slice(2));
  }
  return out;
}

/** Every file under a folder, by relative path, as its own bytes in base64. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const full = join(dir, rel);
    if (statSync(full).isFile()) out[rel] = readFileSync(full).toString('base64');
  }
  return out;
}

describe('team usage', () => {
  test('the project block is the header, the rows, the watch line — and status rows it', async () => {
    withState();
    const mine = await usageAt(root);
    expect(mine.err).toBe('');
    expect(mine.out).toBe(`${BLOCK}\n`);
    expect(mine.code).toBe(0);

    // The rows are `status`'s own, over the same state: the fresh, unknown and last-seen rows
    // are byte-identical to what its budgets table prints.
    const io = testIo(root, { kind: 'owner' });
    await runStatus(['--file', file], io, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => null,
      standing: () => approvalStanding(root, home),
      now: () => NOW,
      home,
    });
    expect(rowsUnder(mine.out, 'team acme')).toEqual(rowsUnder(io.out, 'budgets:'));
  });

  test('--json prints the same reading as one document, format 1', async () => {
    withState();
    const { code, out } = await usageAt(root, undefined, '--json');
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(code).toBe(0);
    expect(doc.format).toBe(1);
    expect(doc.at).toBe('2026-10-04T09:00:00.000Z');
    expect(doc.view).toBe('restricted');
    expect(doc.mine).toBe('acme');
    expect(doc.watch).toBe('not-recording');
    expect(doc.notes).toEqual([]);
    expect(doc.rows).toEqual([
      { account: 'anthropic', window: null, left: null, used: null, resetsIn: null, seat: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: 10 },
      { account: 'openai', window: 'session', left: 40, used: 60, resetsIn: '44m', seat: null, age: '2m', source: 'check', fallback: false, state: 'fresh', inside: false, reserve: 20 },
      { account: 'openai', window: 'daily', left: 70, used: 30, resetsIn: null, seat: 'lead', age: '40m', source: 'status_line', fallback: true, state: 'stale', inside: false, reserve: 20 },
      { account: 'openai', window: 'weekly', left: 5, used: 95, resetsIn: '44m', seat: 'lead', age: '2m', source: 'status_line', fallback: true, state: 'fresh', inside: true, reserve: 20 },
    ]);
  });

  test('a watch whose heartbeat is fresh prints no watch line; a stale or odd one says which', async () => {
    withState({ pid: 1, heartbeat: '2026-10-04T08:59:30Z' });
    const recording = await usageAt(root);
    expect(recording.out).not.toContain('watch');

    withState({ pid: 1, heartbeat: '2026-10-04T08:55:00Z' });
    const stale = await usageAt(root);
    expect(stale.out).toContain('no watch is recording for acme\n');

    withState({ pid: 1, heartbeat: 'not a time' });
    const odd = await usageAt(root);
    expect(odd.out).toContain('not known whether a watch is recording\n');
  });

  test('an unreadable state is a note line with its path, and the rows still print', async () => {
    const state = join(root, '.agents', 'team.state.json');
    writeFileSync(state, 'not json');
    const { code, out } = await usageAt(root);
    expect(code).toBe(0);
    expect(out).toContain(`note: ${state} is not valid JSON; move it aside and run the command again`);
    expect(out).toContain('  anthropic  unknown\n');
    expect(out).toContain('  openai  unknown\n');
    expect(out).toContain('not known whether a watch is recording\n');
  });

  test('outside any project it is a note and exit 0, in text and in JSON', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    const text = await usageAt(elsewhere);
    expect(text.code).toBe(0);
    expect(text.err).toBe('');
    expect(text.out).toBe(`note: ${NO_PROJECT}\n`);
    const json = await usageAt(elsewhere, undefined, '--json');
    expect(JSON.parse(json.out)).toEqual({
      format: 1,
      at: '2026-10-04T09:00:00.000Z',
      view: 'restricted',
      mine: null,
      rows: [],
      watch: 'not-known',
      notes: [NO_PROJECT],
    });
  });

  test('a repository with no team file answers the same way', async () => {
    const repo = join(base, 'empty-repo');
    mkdirSync(repo);
    execFileSync('git', ['init', repo], { env: gitEnv(), stdio: 'ignore' });
    const { code, out } = await usageAt(repo);
    expect(code).toBe(0);
    expect(out).toBe(`note: ${NO_PROJECT}\n`);
  });

  test("a file that exists and does not load is the loader's own message, with the path", async () => {
    writeFileSync(file, 'format: 1\nproject: acme\n');
    const { code, out } = await usageAt(root);
    expect(code).toBe(0);
    expect(out.startsWith(`note: ${file}`)).toBe(true);
    expect(out).toContain('team.yaml');
    expect(out).not.toContain('team acme\n');
  });

  test('any caller may run it, and a subfolder of a checkout reads the same project', async () => {
    withState();
    const seat: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };
    const unplaced: Caller = { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' };
    expect((await usageAt(root, seat)).out).toBe(`${BLOCK}\n`);
    expect((await usageAt(root, unplaced)).out).toBe(`${BLOCK}\n`);

    execFileSync('git', ['init', root], { env: gitEnv(), stdio: 'ignore' });
    const sub = join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const nested = await usageAt(sub, seat);
    expect(nested.out).toBe(`${BLOCK}\n`);
  });

  test('the invocation is the one refusal, and it prints the usage', async () => {
    const io = testIo(root);
    const code = await runUsage(['--nope'], io, { home, now: () => NOW });
    expect(code).toBe(2);
    expect(io.err).toBe(`team usage: unknown option --nope\n${USAGE}`);
    const extra = testIo(root);
    expect(await runUsage(['now'], extra, { home, now: () => NOW })).toBe(2);
    expect(extra.err).toBe(`team usage: unexpected "now"\n${USAGE}`);
  });

  test('it writes nothing: every file under the state, the store and the key is byte-identical', async () => {
    withState();
    const watched = [join(root, '.agents'), join(home, '.config', 'team'), join(home, '.config', 'team-key')];
    const seat: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };

    // Each face of the command, allowed or refused, with the folders compared around it: the
    // block, its JSON, a seat's run, a run outside any project, a refused invocation, a file
    // that does not load, and a state that does not read.
    await untouched(watched, () => usageAt(root));
    await untouched(watched, () => usageAt(root, undefined, '--json'));
    await untouched(watched, () => usageAt(root, seat));
    await untouched(watched, async () => {
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(elsewhere);
      await usageAt(elsewhere);
    });
    await untouched(watched, () => runUsage(['--nope'], testIo(root), { home, now: () => NOW }));
    writeFileSync(join(root, '.agents', 'team.state.json'), 'not json');
    await untouched(watched, () => usageAt(root));
    writeFileSync(file, 'format: 1\nproject: acme\n');
    await untouched(watched, () => usageAt(root));
  });
});

/** Run one scenario with the watched folders snapshotted around it. */
async function untouched(watched: string[], run: () => Promise<unknown>): Promise<void> {
  const before = watched.map((dir) => snapshot(dir));
  await run();
  watched.forEach((dir, index) => expect(snapshot(dir)).toEqual(before[index] as Record<string, string>));
}
