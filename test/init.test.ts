import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, runInit, skeleton } from '../src/commands/init.ts';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { version } from '../src/cli.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { testIo } from './helpers.ts';

let base: string;
let project: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-init-')));
  project = join(base, 'acme');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const owner = { kind: 'owner' } as const;

describe('team init', () => {
  test('writes a skeleton that validates, and says how it stays private', async () => {
    const io = testIo(project, owner);
    expect(await init([], io)).toBe(0);
    const loaded = loadTeamFile(project);
    expect(loaded).toMatchObject({ ok: true, team: { project: 'acme', coordinator: 'coordinator' } });
    expect(io.out).toContain('private to this clone');
    expect(io.out).toContain('team approve');
    expect(readFileSync(join(project, '.agents', 'team.log'), 'utf8')).toMatch(/ init \[owner\] wrote a skeleton as \.agents\/team\.yaml/);
  });

  test('writes # yaml-language-server: $schema line pointing at versioned schema as the first line', async () => {
    const io = testIo(project, owner);
    expect(await init([], io)).toBe(0);
    const content = readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
    const firstLine = content.split('\n')[0];
    const expected = `# yaml-language-server: $schema=https://raw.githubusercontent.com/floor/team/v${version()}/schema/team.schema.json`;
    expect(firstLine).toBe(expected);
  });

  test('a team file with and without the schema line produces identical approval fingerprints and zero drift', () => {
    const withLine = skeleton('my-proj', null);
    const withoutLine = withLine.replace(/^# yaml-language-server: [^\n]+\n/, '');
    expect(withLine).not.toBe(withoutLine);
    expect(withoutLine.startsWith('# The team of')).toBe(true);

    const resWithout = validateTeamFile(withoutLine);
    const resWith = validateTeamFile(withLine);
    expect(resWithout.ok).toBe(true);
    expect(resWith.ok).toBe(true);

    if (resWithout.ok && resWith.ok) {
      const fpWithout = fingerprints(resWithout.team);
      const fpWith = fingerprints(resWith.team);
      expect(fpWith.sections).toEqual(fpWithout.sections);
      expect(fpWith.seats).toEqual(fpWithout.seats);

      const fixedDate = new Date(1700000000000);
      expect(approvalOf(resWith.team, project, fixedDate)).toEqual(approvalOf(resWithout.team, project, fixedDate));

      const home = join(base, 'home');
      mkdirSync(home);
      writeApproval(storePath(resWithout.team.project, project, home), { approval: approvalOf(resWithout.team, project), file: withoutLine }, resWithout.team.seats, home);
      expect(approvalDifferences(resWith.team, project, home)).toEqual([]);

      writeApproval(storePath(resWith.team.project, project, home), { approval: approvalOf(resWith.team, project), file: withLine }, resWith.team.seats, home);
      expect(approvalDifferences(resWithout.team, project, home)).toEqual([]);
    }
  });

  test('suggests the current commit as identity.since, as a comment', async () => {
    await init([], testIo(project, owner));
    const head = git(project, 'rev-parse', 'HEAD').trim();
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toContain(`#   since: ${head}`);
  });

  test('keeps the file and the runtime files out of git through info/exclude, never .gitignore', async () => {
    await init([], testIo(project, owner));
    writeFileSync(join(project, '.agents', 'team.state.json'), '{}');
    writeFileSync(join(project, '.agents', 'team.log.1'), '');
    writeFileSync(join(project, '.agents', 'team.lock'), '1');
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(project, '.gitignore'))).toBe(false);
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.agents/team.yaml\n');
  });

  test('a linked worktree shares the exclusion', async () => {
    await init([], testIo(project, owner));
    const worktree = join(base, 'wt');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');
    mkdirSync(join(worktree, '.agents'));
    writeFileSync(join(worktree, '.agents', 'team.yaml'), 'x');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  test('run from a subfolder or a worktree, it writes in the main checkout', async () => {
    const worktree = join(base, 'wt');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');
    expect(await init([], testIo(worktree, owner))).toBe(0);
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(true);
    expect(existsSync(join(worktree, '.agents'))).toBe(false);
  });

  test('refuses when the file exists, and leaves it as it is', async () => {
    mkdirSync(join(project, '.agents'));
    writeFileSync(join(project, '.agents', 'team.yaml'), 'mine\n');
    const io = testIo(project, owner);
    expect(await init([], io)).toBe(1);
    expect(io.err).toContain('exists already');
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe('mine\n');
  });

  test('refuses a file tracked by git, says how to untrack it, and rewrites nothing', async () => {
    mkdirSync(join(project, '.agents'));
    writeFileSync(join(project, '.agents', 'team.yaml'), 'tracked\n');
    git(project, 'add', '.agents/team.yaml');
    git(project, 'commit', '-q', '-m', 'oops');
    const before = git(project, 'rev-parse', 'HEAD');
    const io = testIo(project, owner);
    expect(await init([], io)).toBe(1);
    expect(io.err).toContain('git rm --cached .agents/team.yaml');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('refuses every caller but the owner, and writes nothing', async () => {
    for (const caller of [{ kind: 'seat', name: 'codex-acme', pane: 'w2:p1' }, { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' }] as const) {
      const io = testIo(project, caller);
      expect(await init([], io)).toBe(1);
      expect(io.err).toContain('only the owner runs init');
    }
    // The owner's own process with no terminal: only `up` may run for it. Every other command
    // refuses it with main's own line — where this caller was `unplaced`, with this reason — so a
    // script that reads the refusal sees the same sentence main printed, byte for byte.
    const noTty = testIo(project, { kind: 'owner-no-tty' });
    expect(await init([], noTty)).toBe(1);
    expect(noTty.err).toContain('only the owner runs init');
    expect(noTty.err).toContain('this call is unplaced (it doesn\'t run on a terminal)');
    expect(existsSync(join(project, '.agents'))).toBe(false);
  });

  test('--restore brings back the copy last approved on this machine', async () => {
    const home = join(base, 'home');
    const text = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
    const result = validateTeamFile(text);
    if (!result.ok) throw new Error('the example does not validate');
    writeApproval(storePath(result.team.project, project, home), { approval: approvalOf(result.team, project), file: text }, [], home);
    const io = testIo(project, owner);
    expect(await runInit(['--restore'], io, home)).toBe(0);
    expect(readFileSync(join(project, '.agents', 'team.yaml'), 'utf8')).toBe(text);
    expect(io.out).toContain('Restored .agents/team.yaml');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  test('--restore with nothing approved writes nothing', async () => {
    const io = testIo(project, owner);
    expect(await runInit(['--restore'], io, join(base, 'home'))).toBe(1);
    expect(io.err).toContain('nothing to restore');
    expect(existsSync(join(project, '.agents'))).toBe(false);
  });

  test('outside a repository, and with an unknown option', async () => {
    expect(await init([], testIo(base, owner))).toBe(2);
    const io = testIo(project, owner);
    expect(await init(['--force'], io)).toBe(2);
    expect(io.err).toContain('unknown option --force');
  });
});

test('the skeleton validates with and without a first commit', () => {
  expect(validateTeamFile(skeleton('acme', null)).ok).toBe(true);
  expect(validateTeamFile(skeleton('acme', 'abc1234')).ok).toBe(true);
});
