import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedFingerprints } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { commands, main } from '../src/cli.ts';
import { runIssues } from '../src/commands/issues.ts';
import { taskPathStaysInside } from '../src/file/sections/tasks.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession } from '../src/state.ts';
import type { TaskAdapter } from '../src/tasks/adapter.ts';
import { newMemory, pass, RING_TEXT } from '../src/watch/pass.ts';
import { testIo } from './helpers.ts';

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

const WITH = `${TEAM}tasks:
  source: file
  path: .agents/tasks.yaml
`;

let base: string;
let root: string;
let home: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function project(text = WITH): void {
  base = mkdtempSync(join(tmpdir(), 'team-issues-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

function list(text: string): void {
  writeFileSync(join(root, '.agents', 'tasks.yaml'), text);
}

async function run(argv: string[] = [], registry?: Record<string, TaskAdapter>) {
  const io = testIo(root);
  const code = await runIssues(argv, io, { home, ...(registry ? { registry } : {}) });
  return { code, out: io.out, err: io.err };
}

describe('team issues', () => {
  test('a list prints id and title, and a later priority stays below an unprioritised record', async () => {
    project();
    list('- id: m1\n  title: the task title\n');
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    list('- id: m1\n  title: the task title\n- id: m2\n  title: another title\n  priority: 1\n');
    expect(await run()).toEqual({
      code: 0,
      out: 'm1  the task title\n\nm2  another title\n  priority: 1\n',
      err: '',
    });
  });

  test('tasks validates, and a file without it still validates', () => {
    expect(validateTeamFile(WITH).ok).toBe(true);
    const bare = validateTeamFile(TEAM);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.team.tasks).toBeNull();
  });

  test('a record without a title is refused and its sibling still prints', async () => {
    project();
    list('- id: m1\n- id: m2\n  title: another title\n');
    expect(await run()).toEqual({
      code: 1,
      out: 'm2  another title\n',
      err: 'team issues: m1 is not a task: title is required\n',
    });
  });

  test('an omitted field is not printed', async () => {
    project();
    list('- id: m1\n  title: the task title\n');
    const listed = await run();
    expect(listed.out).toBe('m1  the task title\n');
    for (const word of ['priority', 'assignee', 'milestone', 'deadline', 'blocked-by', 'repos', 'needs', 'description']) {
      expect(listed.out).not.toContain(word);
    }
  });

  test('blocked-by is shown and does not drop the record', async () => {
    project();
    list('- id: m1\n  title: the task title\n  blocked-by: [m0]\n- id: m2\n  title: another title\n');
    const listed = await run();
    expect(listed.code).toBe(0);
    expect(listed.out).toBe('m1  the task title\n  blocked-by: m0\n\nm2  another title\n');
  });

  test('a broker source is refused by name, and the task file is not read', async () => {
    // A linear source without its block: the validator names both halves it needs.
    const text = WITH.replace('source: file', 'source: linear');
    const checked = validateTeamFile(text);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      const messages = checked.errors.map((error) => error.message);
      expect(messages).toContain('tasks.linear.project is required');
      expect(messages).toContain('tasks.linear.keychainService is required');
    }
    project(text);
    list('- id: m1\n  title: the task title\n');
    const ran = await run();
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team issues: tasks.linear.project is required\n');
    expect(ran.out).toBe('');

    // A full broker source validates — and this command still lists no broker source: the read
    // lives behind the socket, the seat gate and the policy, none of which this command has.
    const linear = `${TEAM}tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
`;
    project(linear);
    list('- id: m1\n  title: the task title\n');
    const broker = await run();
    expect(broker.code).toBe(1);
    expect(broker.err).toBe('team issues: team issues lists the file the owner committed; a broker source is read by team next\n');
    expect(broker.out).toBe('');
  });

  test('an empty list, a missing file, and a file with no task source', async () => {
    project();
    list('[]\n');
    expect(await run()).toEqual({ code: 0, out: 'team issues: nothing is waiting\n', err: '' });
    rmSync(join(root, '.agents', 'tasks.yaml'));
    expect(await run()).toEqual({ code: 1, out: '', err: 'team issues: the task file is not there\n' });
    project(TEAM);
    expect(await run()).toEqual({ code: 1, out: '', err: 'team issues: the team file declares no task source\n' });
  });

  test('repos and needs are shown and not judged', async () => {
    project();
    list('- id: m1\n  title: the task title\n  repos: [other]\n  needs: [review]\n');
    expect(await run()).toEqual({
      code: 0,
      out: 'm1  the task title\n  repos: other\n  needs: review\n',
      err: '',
    });
  });

  test('team plan stays an unknown command', async () => {
    expect(commands.issues).toBeDefined();
    expect(commands.next).toBeDefined();
    expect('plan' in commands).toBe(false);
    project();
    const plan = testIo(root);
    expect(await main(['plan'], plan)).toBe(2);
    expect(plan.err.startsWith('team: unknown command "plan"\n')).toBe(true);
  });

  test('a listing creates no key, and a pass with no mailbox record does not ring', () => {
    project();
    list('- id: m1\n  title: the task title\n');
    return run().then((listed) => {
      expect(listed.code).toBe(0);
      expect(existsSync(join(home, '.config', 'team-key'))).toBe(false);
      expect(RING_TEXT).toBe('Team: run team messages');
      const checked = validateTeamFile(TEAM);
      if (!checked.ok) throw new Error('the fixture does not validate');
      const result = pass({
        team: checked.team,
        state: emptySession(),
        live: { running: false, agents: [], workspaces: [], screens: {} },
        machine: { loadPerCore: null, memoryFree: null, diskFree: null, swapTotal: null, swapFree: null, swapUsed: null },
        now: Date.parse('2026-10-08T09:00:00Z'),
        memory: newMemory(),
        watch: checked.team.watch,
        mailbox: [],
      });
      expect(result.ring).toBeNull();
      expect(result.mailboxNote).toBeNull();
      expect(JSON.stringify(result)).not.toContain('team issues');
    });
  });

  test('a stub adapter registered on the seam prints its records, and an unregistered source is refused', async () => {
    project();
    list('- id: m1\n  title: the task title\n');
    let read = false;
    const stub: TaskAdapter = {
      name: 'file',
      read: () => {
        read = true;
        return { kind: 'records', records: [{ id: 's1', title: 'from the stub' }], refusals: [] };
      },
    };
    expect(await run([], { file: stub })).toEqual({ code: 0, out: 's1  from the stub\n', err: '' });
    expect(read).toBe(true);
    const missed = await run([], {});
    expect(missed).toEqual({ code: 1, out: '', err: 'team issues: tasks.source must be file\n' });
  });

  test('a record that fails its id is named by its place in the file', async () => {
    project();
    list('- title: the task title\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: record 1 is not a task: id is required\n',
    });
  });

  test('a single-line field refuses a carriage return, and a description keeps one', async () => {
    project();
    list('- id: m1\n  title: "first\\rsecond"\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: title must be a single line\n',
    });
    list('- id: m1\n  title: "first\\nsecond"\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: title must be a single line\n',
    });
    list('- id: m1\n  title: the task title\n');
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });
    const fields: Array<[string, string]> = [
      ['assignee: "a\\rb"', 'assignee must be text'],
      ['milestone: "a\\rb"', 'milestone must be text'],
      ['deadline: "a\\rb"', 'deadline must be text'],
      ['priority: "a\\rb"', 'priority is not text or a number'],
      ['repos: ["a\\rb"]', 'repos is not a list of names'],
      ['needs: ["a\\rb"]', 'needs is not a list of names'],
    ];
    for (const [field, reason] of fields) {
      list(`- id: m1\n  title: the task title\n  ${field}\n`);
      expect(await run()).toEqual({ code: 1, out: '', err: `team issues: m1 is not a task: ${reason}\n` });
    }
    list('- id: m1\n  title: the task title\n  description: "first\\rsecond"\n');
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n  description: first\rsecond\n', err: '' });
  });

  test('a description may contain newlines, and one trailing newline is not an extra line', async () => {
    project();
    const block = 'm1  the task title\n  description: first\n    second\n';
    list('- id: m1\n  title: the task title\n  description: "first\\nsecond"\n');
    expect(await run()).toEqual({ code: 0, out: block, err: '' });
    // The value a `|` block denotes, including its closing newline.
    list('- id: m1\n  title: the task title\n  description: "first\\nsecond\\n"\n');
    expect(await run()).toEqual({ code: 0, out: block, err: '' });
    list('- id: m1\n  title: the task title\n  description: "first\\n\\nsecond"\n');
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n  description: first\n\n    second\n', err: '' });
    list(`- id: m1\n  title: the task title\n  description: "${'a'.repeat(3999)}\\n"\n`);
    expect((await run()).code).toBe(0);
    list(`- id: m1\n  title: the task title\n  description: "${'a'.repeat(4000)}\\n"\n`);
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: description is over 4000 characters\n',
    });
    list('- id: m1\n  title: the task title\n  description: ""\n');
    expect(await run()).toEqual({
      code: 1,
      out: '',
      err: 'team issues: m1 is not a task: description must be text\n',
    });
  });

  test('a name that starts with .. stays inside the checkout, and a real escape does not', async () => {
    project();
    mkdirSync(join(root, '..tasks'));
    writeFileSync(join(root, '..tasks', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
    const direct = `${TEAM}tasks:\n  source: file\n  path: ..tasks/tasks.yaml\n`;
    expect(validateTeamFile(direct, { root }).ok).toBe(true);
    expect(taskPathStaysInside('..tasks/tasks.yaml', root)).toBe(true);
    writeFileSync(join(root, '.agents', 'team.yaml'), direct);
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });

    symlinkSync(join(root, '..tasks'), join(root, 'via'));
    const via = `${TEAM}tasks:\n  source: file\n  path: via/tasks.yaml\n`;
    expect(validateTeamFile(via, { root }).ok).toBe(true);
    writeFileSync(join(root, '.agents', 'team.yaml'), via);
    expect(await run()).toEqual({ code: 0, out: 'm1  the task title\n', err: '' });

    for (const path of ['../outside.yaml', '/tmp/outside.yaml', 'foo\\bar.yaml', '~/x', 'a\0b']) {
      expect(taskPathStaysInside(path, root)).toBe(false);
      const result = validateTeamFile(`${TEAM}tasks:\n  source: file\n  path: ${path}\n`, { root });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.message)).toContain('tasks.path must stay inside the checkout');
    }

    const elsewhere = mkdtempSync(join(tmpdir(), 'team-issues-out-'));
    writeFileSync(join(elsewhere, 'tasks.yaml'), '- id: m1\n  title: the task title\n');
    symlinkSync(elsewhere, join(root, 'linked'));
    const linked = `${TEAM}tasks:\n  source: file\n  path: linked/tasks.yaml\n`;
    const outside = validateTeamFile(linked, { root });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.errors.map((error) => error.message)).toContain('tasks.path must stay inside the checkout');
    writeFileSync(join(root, '.agents', 'team.yaml'), linked);
    expect(await run()).toEqual({ code: 1, out: '', err: 'team issues: tasks.path must stay inside the checkout\n' });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test('an old approval adopts an omitted tasks section, and adding one differs', () => {
    const bare = validateTeamFile(TEAM);
    const added = validateTeamFile(WITH);
    if (!bare.ok || !added.ok) throw new Error('the fixtures do not validate');
    const stored = fingerprints(bare.team);
    delete stored.sections.tasks;
    const stillOmitted = approvedFingerprints({ approval: { fingerprints: stored }, file: TEAM } as never);
    expect(fingerprints(bare.team).sections.tasks).toBe(stillOmitted.sections.tasks);
    const gained = approvedFingerprints({ approval: { fingerprints: { ...stored, sections: { ...stored.sections } } }, file: WITH } as never);
    expect(gained.sections.tasks).not.toBe(fingerprints(added.team).sections.tasks);
  });
});
