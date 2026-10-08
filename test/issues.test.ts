import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedFingerprints } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { commands, main } from '../src/cli.ts';
import { runIssues } from '../src/commands/issues.ts';
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

  test('a source other than file is refused and the task file is not read', async () => {
    const text = WITH.replace('source: file', 'source: linear');
    const checked = validateTeamFile(text);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.map((error) => error.message)).toContain('tasks.source must be file');
    project(text);
    list('- id: m1\n  title: the task title\n');
    const ran = await run();
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team issues: tasks.source must be file\n');
    expect(ran.out).toBe('');
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

  test('team next and team plan stay unknown commands', async () => {
    expect(commands.issues).toBeDefined();
    expect('next' in commands).toBe(false);
    expect('plan' in commands).toBe(false);
    project();
    const next = testIo(root);
    expect(await main(['next'], next)).toBe(2);
    expect(next.err.startsWith('team: unknown command "next"\n')).toBe(true);
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
