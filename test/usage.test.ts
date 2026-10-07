// `team usage` — S1: one project's block, resolved from the current folder and read-only. Its
// rows are `status`'s own rows (the same rule and the same table), and the four holds of the
// brief are tested too: nothing is written, no pane or key or CLI session file is read, any
// caller may run it from any folder, and every figure carries its source and its age. The
// restricted view's own rules are here as well: a refused approval's words reach the owner and
// nobody else, whatever the reason (`NOT_VERIFIED`); a file that does not load or cannot be read
// is one fixed sentence per line for every caller who is not the owner, never the loader's body —
// whose bodies can name paths outside this project — and every other note names this project's
// own paths relative to the project root. No absolute path reaches such a caller (`expectNoAbsolute`).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runStatus } from '../src/commands/status.ts';
import { NO_PROJECT, runUsage, USAGE } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { NOTHING_COUNTED, NOT_VERIFIED } from '../src/information/usage.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');

/** A seat's caller: the restricted view's ordinary reader, handed in so no test's view depends on
 *  the process tree it is run from. */
const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };

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

// The rows the same readings print when no budget in force names an account: the check figure has
// no source left to count from, the 40-minute-old status-line figure is no room last seen, and
// the fresh one prints without the reserve and fallback marks no budget gives it. Each is a
// reading the state still holds, not an account any budget in force names.
const LEFTOVER_ROWS = [
  '  openai  session  unknown',
  '  openai  daily  unknown',
  '  openai  weekly  left 5%  used 95%  resets in 44m  lead  changed 2m ago  status line  fresh',
];

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

/** The same file with its whole `budgets:` section taken out: it names no account. */
function withoutBudgets(): string {
  const text = teamText();
  return text.slice(0, text.indexOf('budgets:')) + text.slice(text.indexOf('seats:'));
}

/** The store's record for one text: what `team approve` leaves, signed by the key the store
 *  writes on first use. The budgets section takes effect only once the owner has approved it. */
function approve(text: string): void {
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
  writeApproval(storePath(checked.team.project, root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, [], home);
}

/** A state with the session recorded and no readings at all: with no readings to hold, the
 *  table prints no rows, and the watch line reads `no watch is recording for <project>`. */
function withoutReadings(): void {
  updateState(join(root, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession() } as never;
  });
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
  approve(text);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function usageAt(cwd: string, caller?: Caller, ...argv: string[]) {
  const io = testIo(cwd, caller);
  const code = await runUsage(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

/** Nothing a caller who is not the owner reads may name a path outside this project: no string
 *  starting at the filesystem root or at the home folder, in the block or in `--json`. The
 *  fixture's own base is under `/tmp`, and its home under the base, so naming either catches a
 *  body that slipped through; the pattern catches any other leading-slash token at a boundary. */
function expectNoAbsolute(faces: string[], why?: string): void {
  for (const face of faces) {
    expect(face, why).not.toContain(base);
    expect(face, why).not.toContain(home);
    expect(face, why).not.toMatch(/(^|[\s"'()[\]=:,])\/[^\s"',;)\]]/);
  }
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

  test('an unreadable state is a note line: the path is absolute for the owner, relative for a seat', async () => {
    const state = join(root, '.agents', 'team.state.json');
    writeFileSync(state, 'not json');
    const why = 'is not valid JSON; move it aside and run the command again';

    // The owner reads the state's message exactly as the state wrote it, its absolute path and
    // all, and the rows still print under it.
    const owner = await usageAt(root, { kind: 'owner' });
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`note: ${state} ${why}`);
    expect(owner.out).toContain('  anthropic  unknown\n');
    expect(owner.out).toContain('  openai  unknown\n');
    expect(owner.out).toContain('not known whether a watch is recording\n');

    // A caller who is not the owner reads the project's own path relative to the project root —
    // and no absolute path at all, the fixture's base included — in the block and in `--json`.
    const mine = await usageAt(root, SEAT);
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect(mine.code).toBe(0);
    expect(mine.out).toContain(`note: .agents/team.state.json ${why}`);
    expect(mine.out).toContain('  anthropic  unknown\n');
    expectNoAbsolute([mine.out, raw]);
    expect((JSON.parse(raw) as { notes: string[] }).notes).toEqual([`.agents/team.state.json ${why}`]);
  });

  test('a file that names no account prints why nothing is counted, under leftover rows too', async () => {
    // The file the owner approved names no account, so the budgets in force name none either.
    const text = withoutBudgets();
    writeFileSync(file, text);
    approve(text);

    // No readings at all: the block is the header, the sentence and the watch line.
    withoutReadings();
    const bare = await usageAt(root);
    expect(bare.code).toBe(0);
    expect(bare.out).toBe(['team acme', NOTHING_COUNTED, 'no watch is recording for acme'].join('\n') + '\n');
    const doc = JSON.parse((await usageAt(root, undefined, '--json')).out) as Record<string, unknown>;
    expect(doc.rows).toEqual([]);
    expect(doc.notes).toEqual([NOTHING_COUNTED]);

    // A state that still holds readings prints their rows — they are readings, not accounts a
    // budget in force names — and the sentence still prints, under them; the JSON says the same.
    withState();
    const leftover = await usageAt(root);
    expect(leftover.code).toBe(0);
    expect(leftover.out).toBe(['team acme', ...LEFTOVER_ROWS, NOTHING_COUNTED, 'no watch is recording for acme'].join('\n') + '\n');
    const held = JSON.parse((await usageAt(root, undefined, '--json')).out) as Record<string, unknown>;
    expect((held.rows as unknown[]).length).toBe(LEFTOVER_ROWS.length);
    expect(held.notes).toEqual([NOTHING_COUNTED]);
  });

  test('a file whose accounts are not the approved ones prints the why-line, rows or no rows', async () => {
    // Never approved: the store holds no record for this project, so the file's accounts — which
    // it declares — are not in force, and the tool's own why-line for that standing prints. The
    // rows the state still holds print above it: the line keys on the standing, not on them.
    rmSync(storePath('acme', root, home), { recursive: true, force: true });
    const neverApproved = 'the file was never approved on this machine: run `team approve`';
    withoutReadings();
    const bare = await usageAt(root);
    expect(bare.code).toBe(0);
    expect(bare.out).toBe(['team acme', neverApproved, 'no watch is recording for acme'].join('\n') + '\n');
    withState();
    const none = await usageAt(root);
    expect(none.out).toBe(['team acme', ...LEFTOVER_ROWS, neverApproved, 'no watch is recording for acme'].join('\n') + '\n');
    expect(JSON.parse((await usageAt(root, undefined, '--json')).out).notes).toEqual([neverApproved]);

    // Verified, but the copy the owner approved names no account: the budgets in force are the
    // approved copy's, so the file's own accounts count nothing and `status`'s line for a file
    // that differs from the approved one prints — again under the readings' own rows.
    const text = withoutBudgets();
    writeFileSync(file, text);
    approve(text);
    writeFileSync(file, teamText());
    const differs = 'the file differs from the approved one: `budgets` changed';
    const moved = await usageAt(root);
    expect(moved.code).toBe(0);
    expect(moved.out).toBe(['team acme', ...LEFTOVER_ROWS, differs, 'no watch is recording for acme'].join('\n') + '\n');
    expect(JSON.parse((await usageAt(root, undefined, '--json')).out).notes).toEqual([differs]);
  });

  test("a refused approval's own words are the owner's: one fixed sentence for a seat, every reason", async () => {
    const text = teamText();
    const store = storePath('acme', root, home);
    const record = join(store, 'approval.json');
    const keyFile = join(home, '.config', 'team-key', 'key.json');
    const generations = join(home, '.config', 'team-key', 'generations');
    const generationFile = () => join(generations, (readdirSync(generations) as string[])[0] as string);
    const read = () => JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>;
    const write = (value: unknown) => writeFileSync(record, `${JSON.stringify(value, null, 2)}\n`);

    // The root of the after-review's case: a name this test owns, so its appearing anywhere in a
    // non-owner's output could only come from the store's own words.
    const foreign = join(base, 'acme-FOREIGN-ROOT-8ZKQ');
    mkdirSync(foreign, { recursive: true });

    /** A clean fixture before each reason: the store, the key and the generations start over. */
    const reset = () => {
      rmSync(join(home, '.config'), { recursive: true, force: true });
      mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
      approve(text);
    };

    const seat: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };
    const owner: Caller = { kind: 'owner' };

    // Every refusal reason `approvalStanding` can produce, with its store.ts line. Two of the ten
    // cannot be reached by a record on disk — `:162`, guarded by the shape check (`store.ts:159-161`),
    // and `:179`, the belt-and-braces catch around `verifyPayload` (`store.ts:174-178`) — so eight
    // are fed here; the pull request lists all ten.
    const refusals: { at: string; refuse: () => void }[] = [
      { at: ':154 the record cannot be read', refuse: () => write({ format: 3 }) },
      { at: ':166 the key is missing', refuse: () => rmSync(keyFile, { force: true }) },
      { at: ':169 the key cannot be read', refuse: () => writeFileSync(keyFile, 'not a key at all') },
      { at: ':182 the signature does not verify', refuse: () => write({ ...read(), file: `${text}\n# changed after signing\n` }) },
      { at: ':185 another project root', refuse: () => {
        const checked = validateTeamFile(text, { home, root });
        if (!checked.ok) throw new Error('the fixture does not validate');
        writeApproval(store, { approval: approvalOf(checked.team, foreign, NOW), file: text }, [], home);
      } },
      { at: ':189 no generation recorded', refuse: () => rmSync(generationFile(), { force: true }) },
      { at: ':193 the record is older than the generation', refuse: () => {
        const earlier = read();
        approve(text);
        write(earlier);
      } },
      { at: ':194 only an older generation is recorded', refuse: () => {
        approve(text);
        writeFileSync(generationFile(), `${JSON.stringify({ format: 1, generation: 1, at: NOW.toISOString() }, null, 2)}\n`);
      } },
    ];

    for (const one of refusals) {
      reset();
      one.refuse();
      const standing = approvalStanding(root, home);
      expect([one.at, standing.kind], one.at).toEqual([one.at, 'refused']);
      const why = (standing as { why: string }).why;

      // A seat gets the one fixed sentence, in both faces, and nothing that names the fixture.
      const mine = await usageAt(root, seat);
      expect(mine.code, one.at).toBe(0);
      expect(mine.out.split('\n'), one.at).toContain(NOT_VERIFIED);
      expect(mine.out, one.at).not.toContain('another project root');

      const raw = (await usageAt(root, seat, '--json')).out;
      expectNoAbsolute([mine.out, raw], one.at);
      expect((JSON.parse(raw) as { notes: string[] }).notes, one.at).toEqual([NOT_VERIFIED]);

      // The owner keeps the store's own words, byte for byte — the leak's own path included.
      const theirs = await usageAt(root, owner);
      expect(theirs.out, one.at).toContain(why);
      if (one.at.startsWith(':185')) {
        expect(why, one.at).toContain(foreign);
        expect(theirs.out, one.at).toContain(foreign);
        expect(mine.out, one.at).not.toContain('FOREIGN-ROOT-8ZKQ');
        expect(raw, one.at).not.toContain('FOREIGN-ROOT-8ZKQ');
      }
    }
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

  test("a file that exists and does not load is the loader's message for the owner, one fixed sentence for anyone else", async () => {
    writeFileSync(file, 'format: 1\nproject: acme\n');

    // The owner reads every note with the file's absolute path, the shape S1 shipped.
    const owner = await usageAt(root, { kind: 'owner' });
    expect(owner.code).toBe(0);
    expect(owner.out.startsWith(`note: ${file} line 1: seats is required`)).toBe(true);
    expect(owner.out).not.toContain('team acme\n');

    // A caller who is not the owner reads one fixed sentence per line instead — this project's
    // own path, the line, and where the reason is — and never a body: the loader's bodies can name
    // paths outside this project (`trust: must list the lobby <home>/…`). The three problems here
    // all name line 1, so the one sentence prints once.
    const mine = await usageAt(root, SEAT);
    expect(mine.code).toBe(0);
    expect(mine.out).toBe('note: .agents/team.yaml does not load (line 1): run team status for the reason\n');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect((JSON.parse(raw) as { notes: string[] }).notes).toEqual(['.agents/team.yaml does not load (line 1): run team status for the reason']);
    expectNoAbsolute([mine.out, raw]);
  });

  test('a file that exists and cannot be read prints the error for the owner, one fixed sentence for anyone else', async () => {
    // A directory where the file would be, in a checkout the loader resolves: the read itself is
    // what fails (`EISDIR`), and its message is the code and the syscall — a recorded run of this
    // branch showed exactly `EISDIR: illegal operation on a directory, read`. An errno error's
    // body can name the path it failed on (`ENOENT: … open '/<path>'`, a recorded probe), so this
    // body does not pass through either: a caller who is not the owner reads one fixed sentence,
    // and its tail is not `run team status`, because a run showed `status` throws on this same
    // fixture instead of printing anything.
    rmSync(file);
    mkdirSync(file, { recursive: true });
    execFileSync('git', ['init', root], { env: gitEnv(), stdio: 'ignore' });
    const note = 'EISDIR: illegal operation on a directory, read';
    const owner = await usageAt(root, { kind: 'owner' });
    expect(owner.code).toBe(0);
    expect(owner.out).toBe(`note: ${note}\n`);
    const mine = await usageAt(root, SEAT);
    expect(mine.code).toBe(0);
    expect(mine.out).toBe('note: .agents/team.yaml cannot be read: the owner reads the reason\n');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect((JSON.parse(raw) as { notes: string[] }).notes).toEqual(['.agents/team.yaml cannot be read: the owner reads the reason']);
    expectNoAbsolute([mine.out, raw]);
  });

  test('no path outside this project reaches a caller who is not the owner, whatever breaks', async () => {
    // Every class the loader, its placement checks, the state and the resolution can hand this
    // command, provoked one at a time. Each runs through both faces, and `expectNoAbsolute` sweeps
    // the whole of each: not a figure or a row depends on who asks, and no note may name a path
    // outside this project. Recorded runs of each case on this branch are quoted in the pull
    // request's list.
    const faces = async (cwd: string): Promise<string> => {
      const text = await usageAt(cwd, SEAT);
      const raw = (await usageAt(cwd, SEAT, '--json')).out;
      expect(text.code).toBe(0);
      expectNoAbsolute([text.out, raw]);
      return text.out;
    };

    // Validation: three problems, all on line 1 — one fixed sentence, once.
    writeFileSync(file, 'format: 1\nproject: acme\n');
    expect(await faces(root)).toBe('note: .agents/team.yaml does not load (line 1): run team status for the reason\n');

    // Placement, no line: the trust list omits the lobby, whose absolute path the loader's body
    // names (`trust: must list the lobby <home>/.config/team/lobby`).
    writeFileSync(file, teamText().replace('  - ~/.config/team/lobby\n', ''));
    expect(await faces(root)).toBe('note: .agents/team.yaml does not load: run team status for the reason\n');

    // Placement, with a line: a trust entry is a symbolic link; the loader's body names the entry
    // and the target it resolves to, both absolute.
    const target = join(base, 'linked-target');
    const linked = join(base, 'linked-entry');
    mkdirSync(target);
    symlinkSync(target, linked);
    const withLink = teamText().replace(`  - ${root}`, `  - ${linked}\n  - ${root}`);
    writeFileSync(file, withLink);
    const entry = withLink.split('\n').findIndex((line) => line.includes(linked)) + 1;
    expect(await faces(root)).toBe(`note: .agents/team.yaml does not load (line ${entry}): run team status for the reason\n`);

    // YAML that does not parse: the parser's own line.
    writeFileSync(file, 'project: [unclosed\n');
    expect(await faces(root)).toBe('note: .agents/team.yaml does not load (line 1): run team status for the reason\n');

    // A file that exists and cannot be read: the read fails with a bare errno error.
    rmSync(file);
    mkdirSync(file, { recursive: true });
    execFileSync('git', ['init', root], { env: gitEnv(), stdio: 'ignore' });
    expect(await faces(root)).toBe('note: .agents/team.yaml cannot be read: the owner reads the reason\n');

    // A team file that is a symbolic link in a plain folder: not followed, so no project here.
    const plain = join(base, 'plain');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    writeFileSync(join(base, 'target.yaml'), 'format: 1\n');
    symlinkSync(join(base, 'target.yaml'), join(plain, '.agents', 'team.yaml'));
    expect(await faces(plain)).toBe(`note: ${NO_PROJECT}\n`);

    // A state that cannot be read: the state's own reason with this project's own path in it.
    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, teamText());
    writeFileSync(join(root, '.agents', 'team.state.json'), 'not json');
    expect(await faces(root)).toContain('note: .agents/team.state.json is not valid JSON; move it aside and run the command again\n');

    // No project at all: the one note, and nothing for it to name.
    const nowhere = join(base, 'nowhere');
    mkdirSync(nowhere);
    expect(await faces(nowhere)).toBe(`note: ${NO_PROJECT}\n`);
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
