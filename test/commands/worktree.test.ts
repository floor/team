import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { readState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo, type TestIo } from '../helpers.ts';

let base: string;
let project: string;
let home: string;
let sources: WorktreeSources;

const owner = { kind: 'owner' } as const;
const lead = { kind: 'seat', name: 'lead', pane: 'w1:p1' } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function teamText(patch?: { setup?: string; limit?: number; mode?: string }): string {
  const mode = patch?.mode ?? 'worktree';
  const setup = patch?.setup ?? '';
  const workspace = mode === 'shared'
    ? 'workspace:\n  mode: shared\n'
    : `workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  limit: ${patch?.limit ?? 8}
${setup}`;
  return `format: 1
project: acme
visibility: public
coordinator: lead
operator: lead
identity:
  forbidden_public:
    - "\\\\bWEB-[0-9]+\\\\b"
trust:
  - ../worktrees/acme/*
${workspace}seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function approve(text: string): void {
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'team.yaml'), text);
  const loaded = loadTeamFile(project);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: text },
    loaded.team.seats,
  );
}

async function run(argv: string[], caller: TestIo['caller'] = owner): Promise<TestIo & { code: number }> {
  const io = testIo(project, caller) as TestIo & { code: number };
  io.code = await runWorktree(argv, io, sources);
  return io;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-worktree-')));
  project = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(project);
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  sources = { home, now: () => new Date('2026-10-03T12:00:00Z') };
  approve(teamText());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team worktree new', () => {
  test('creates the folder and the branch from the fetched base, and prints the path', async () => {
    const io = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'lead']);
    expect(io.code).toBe(0);
    expect(io.out).toBe('../worktrees/acme/select-width\n');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'README.md'))).toBe(true);
    expect(git(project, 'rev-parse', '--verify', 'refs/heads/fix/select-width').trim()).toBe(git(project, 'rev-parse', 'origin/main').trim());
    const state = readState(join(project, '.agents'));
    expect(state.sessions.acme?.worktrees['select-width']).toEqual({
      path: '../worktrees/acme/select-width',
      branch: 'fix/select-width',
      own_commits: false,
      seat: 'lead',
      setup: 'ok',
    });
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toContain('worktree new [owner] created select-width');
  });

  test('a coordinator seat may create one; another seat may not', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'], lead)).code).toBe(0);
    const other = await run(['new', 'other-task', '--kind', 'fix'], { kind: 'seat', name: 'stranger', pane: 'w2:p1' });
    expect(other.code).toBe(1);
    expect(other.err).toContain('only the owner, the coordinator or the operator');
  });

  test('--file is refused from a seat', async () => {
    const io = await run(['new', 'select-width', '--kind', 'fix', '--file', join(project, '.agents', 'team.yaml')], lead);
    expect(io.code).toBe(1);
    expect(io.err).toContain('--file is the owner');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('refuses an unapproved file and a file that has changed since approval', async () => {
    rmSync(home, { recursive: true, force: true });
    const missing = await run(['new', 'select-width', '--kind', 'fix']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('never approved');
    approve(teamText());
    const text = teamText({ limit: 4 });
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    const changed = await run(['new', 'select-width', '--kind', 'fix']);
    expect(changed.code).toBe(1);
    expect(changed.err).toContain('not the approved one');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
  });

  test('refuses shared mode, a public forbidden name, an unknown seat, a taken branch and the limit', async () => {
    approve(teamText({ mode: 'shared' }));
    const shared = await run(['new', 'select-width', '--kind', 'fix']);
    expect(shared.err).toContain('workspace.mode is shared');

    approve(teamText());
    const named = await run(['new', 'WEB-12', '--kind', 'fix']);
    expect(named.code).toBe(1);
    expect(named.err).toContain('forbidden_public');

    const seat = await run(['new', 'select-width', '--kind', 'fix', '--seat', 'nobody']);
    expect(seat.err).toContain('names no declared seat');

    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const again = await run(['new', 'select-width', '--kind', 'fix']);
    expect(again.err).toContain('already recorded');
    git(project, 'branch', 'fix/taken', 'main');
    const taken = await run(['new', 'taken', '--kind', 'fix']);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain('branch fix/taken already exists');

    approve(teamText({ limit: 1 }));
    const limited = await run(['new', 'other-task', '--kind', 'fix']);
    expect(limited.code).toBe(1);
    expect(limited.err).toContain('worktree limit is 1');
    expect(existsSync(join(base, 'worktrees', 'acme', 'other-task'))).toBe(false);
  });

  test('a failed fetch creates nothing', async () => {
    git(project, 'remote', 'set-url', 'origin', join(base, 'missing.git'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('Nothing was created');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
    expect(readState(join(project, '.agents')).sessions.acme).toBeUndefined();
  });

  test('a base with no upstream starts from the local branch', async () => {
    git(project, 'branch', '--unset-upstream');
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(0);
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toContain('no upstream');
  });

  test('a setup failure is kept and recorded, and later commands do not run', async () => {
    approve(teamText({ setup: '  setup:\n    - "false"\n    - "touch no-second"\n' }));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.out).toBe('../worktrees/acme/select-width\n');
    expect(io.err).toContain('setup: failed');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width', 'no-second'))).toBe(false);
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']?.setup).toBe('failed');
  });

  test('a symlink that would land outside trust is refused before the folder exists', async () => {
    const escaped = join(base, 'escaped');
    mkdirSync(escaped);
    symlinkSync(escaped, join(base, 'worktrees'));
    const io = await run(['new', 'select-width', '--kind', 'fix']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('symlink');
    expect(existsSync(join(escaped, 'acme'))).toBe(false);
  });
});

describe('team worktree remove', () => {
  test('removes the folder and the record, and keeps the branch', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(0);
    expect(io.out).toContain('the branch fix/select-width is kept');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(false);
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });

  test('refuses uncommitted changes, untracked files and commits on no remote, and lists them', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const folder = join(base, 'worktrees', 'acme', 'select-width');
    writeFileSync(join(folder, 'README.md'), 'changed\n');
    const dirty = await run(['remove', 'select-width']);
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain('README.md');
    expect(existsSync(folder)).toBe(true);

    git(folder, 'checkout', '-q', '--', 'README.md');
    writeFileSync(join(folder, 'notes.txt'), 'local\n');
    const untracked = await run(['remove', 'select-width']);
    expect(untracked.code).toBe(1);
    expect(untracked.err).toContain('notes.txt');

    rmSync(join(folder, 'notes.txt'));
    writeFileSync(join(folder, 'README.md'), 'committed\n');
    git(folder, 'add', 'README.md');
    git(folder, 'commit', '-q', '-m', 'local only');
    const unpushed = await run(['remove', 'select-width']);
    expect(unpushed.code).toBe(1);
    expect(unpushed.err).toContain('local only');
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');

    git(project, 'push', '-q', 'origin', 'fix/select-width');
    const pushed = await run(['remove', 'select-width']);
    expect(pushed.code).toBe(0);
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/fix/select-width').trim()).not.toBe('');
  });

  test('refuses while a temporary seat is recorded in the task', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    const dir = join(project, '.agents');
    const state = readState(dir);
    const session = state.sessions.acme;
    if (!session) throw new Error('no session');
    session.seats['lead-tmp-1'] = { stage: 'ready', temporary: { like: 'lead', until: 'merged:fix/select-width', task: 'select-width' } };
    writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(1);
    expect(io.err).toContain('lead-tmp-1');
    expect(existsSync(join(base, 'worktrees', 'acme', 'select-width'))).toBe(true);
  });

  test('a folder that is already gone drops the record and deletes no branch', async () => {
    expect((await run(['new', 'select-width', '--kind', 'fix'])).code).toBe(0);
    rmSync(join(base, 'worktrees', 'acme', 'select-width'), { recursive: true, force: true });
    const io = await run(['remove', 'select-width']);
    expect(io.code).toBe(0);
    expect(io.out).toContain('already gone');
    expect(git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/select-width').trim()).not.toBe('');
    expect(readState(join(project, '.agents')).sessions.acme?.worktrees['select-width']).toBeUndefined();
  });
});
