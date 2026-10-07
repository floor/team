import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRoot, loadTeamFile, NOT_A_REPO } from '../src/file/load.ts';
import { gitEnv } from './helpers.ts';

const example = new URL('./fixtures/example.yaml', import.meta.url).pathname;
let base: string;
let project: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore', env: gitEnv() });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-')));
  project = join(base, 'acme-web');
  worktree = join(base, 'worktrees', 'acme-web', 'task');
  mkdirSync(join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the project root', () => {
  test('is the main checkout, from a subfolder and from a linked worktree', () => {
    expect(findRoot(project)).toBe(project);
    expect(findRoot(join(project, 'src'))).toBe(project);
    expect(findRoot(worktree)).toBe(project);
  });
  test('is null outside a repository', () => {
    expect(findRoot(base)).toBeNull();
  });
});

describe('loading the file', () => {
  test('no file: one message says it is private to each clone', () => {
    const result = loadTeamFile(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toMatch(/no team file here; it is private to each clone: run `team init`/);
    expect(result.path).toBe(join(project, '.agents', 'team.yaml'));
  });

  test('a linked worktree reads the main checkout\'s file', () => {
    mkdirSync(join(project, '.agents'), { recursive: true });
    copyFileSync(example, join(project, '.agents', 'team.yaml'));
    const result = loadTeamFile(worktree);
    expect(result).toMatchObject({ ok: true, root: project, path: join(project, '.agents', 'team.yaml') });
  });

  test('an invalid file comes back with its problems and its path', () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 2\n');
    const result = loadTeamFile(join(project, 'src'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((problem) => /format must be 1/.test(problem.message))).toBe(true);
    expect(result.path).toBe(join(project, '.agents', 'team.yaml'));
  });

  test('--file: the root is the folder that holds its .agents/', () => {
    const other = join(base, 'other', '.agents');
    mkdirSync(other, { recursive: true });
    copyFileSync(example, join(other, 'team.yaml'));
    expect(loadTeamFile(base, { file: 'other/.agents/team.yaml' })).toMatchObject({ ok: true, root: join(base, 'other') });
  });

  test('a trust pattern that names the project\'s parent by its own name is refused', () => {
    // The project is <base>/acme-web: "../../<base's name>/*" is every folder beside it.
    const parent = base.split('/').pop() as string;
    const text = readFileSync(example, 'utf8')
      .replace('  - ../worktrees/acme-web/*', `  - ../../${parent}/*`)
      .replace('path: ../worktrees/{repo}/{task}', `path: ../../${parent}/{task}`);
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    const result = loadTeamFile(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.errors.map((problem) => problem.message).join('\n');
    expect(messages).toMatch(/trust: "\.\.\/\.\.\/[^"]+\/\*" names the project's parent/);
    expect(messages).toMatch(/workspace\.path: .* puts worktrees in the project's parent/);
  });

  test('a symlink to the project\'s parent is refused as the parent is', () => {
    symlinkSync(base, join(base, 'alias'));
    const text = readFileSync(example, 'utf8').replace('  - ../worktrees/acme-web/*', '  - ../worktrees/acme-web/*\n  - ../alias/*');
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    const result = loadTeamFile(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/names the project's parent/);
  });

  test('outside a repository and without --file', () => {
    const result = loadTeamFile(base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toBe(NOT_A_REPO);
  });

  test('a folder with no git reads .agents/team.yaml in that folder', () => {
    const plain = join(base, 'plain');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    copyFileSync(example, join(plain, '.agents', 'team.yaml'));
    expect(loadTeamFile(plain)).toMatchObject({
      ok: true,
      root: plain,
      path: join(plain, '.agents', 'team.yaml'),
    });
    const empty = join(base, 'empty-folder');
    mkdirSync(empty);
    const missing = loadTeamFile(empty);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.path).toBeUndefined();
      expect(missing.errors[0]?.message).toBe(NOT_A_REPO);
    }
  });

  test('a parent folder\'s file is not found', () => {
    const parent = join(base, 'holding');
    const child = join(parent, 'child');
    mkdirSync(join(parent, '.agents'), { recursive: true });
    mkdirSync(child);
    copyFileSync(example, join(parent, '.agents', 'team.yaml'));
    const result = loadTeamFile(child);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).toBeUndefined();
    expect(result.errors[0]?.message).toBe(NOT_A_REPO);
  });
});

// The git-project inputs of the tests above, run through this tree and through origin/main.
// The fallback is the no-repository case only, so these stay identical — save the lead's own
// refusal, which the field replaced with the key: the two trees name it differently, and both
// texts read as one marker here so the parity of everything else stays the assertion.
const LEAD_REFUSAL = /^(coordinator is required|the file has no seat that leads: put `leads: true` on one seat)$/;
test('a git project loads as the main tree loads it', async () => {
  const { pathToFileURL } = await import('node:url');
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dir,
    encoding: 'utf8',
  }).trim();
  const archive = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-main-')));
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-both-')));
  try {
    const packed = join(archive, 'main.tar');
    execFileSync('git', ['archive', '-o', packed, 'origin/main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('tar', ['-x', '-C', archive, '-f', packed], { stdio: 'ignore' });
    rmSync(packed);
    const main = await import(pathToFileURL(join(archive, 'src/file/load.ts')).href) as {
      findRoot(cwd: string): string | null;
      loadTeamFile(cwd: string, options?: { file?: string }): {
        ok: boolean;
        root?: string;
        path?: string;
        errors?: { message: string }[];
      };
    };
    const project = join(fixture, 'acme-web');
    const worktree = join(fixture, 'worktrees', 'acme-web', 'task');
    mkdirSync(join(project, 'src'), { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    writeFileSync(join(project, 'README.md'), 'acme\n');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'first');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'task');

    const shape = (result: { ok: boolean; root?: string; path?: string; errors?: { message: string }[] }) =>
      result.ok
        ? { ok: true as const, root: result.root, path: result.path }
        : { ok: false as const, path: result.path, errors: result.errors?.map((problem) => problem.message.replace(LEAD_REFUSAL, 'the lead is required')) };
    const same = (cwd: string, options?: { file?: string }) => {
      expect(shape(loadTeamFile(cwd, options))).toEqual(shape(main.loadTeamFile(cwd, options)));
    };

    expect(findRoot(project)).toBe(main.findRoot(project));
    expect(findRoot(join(project, 'src'))).toBe(main.findRoot(join(project, 'src')));
    expect(findRoot(worktree)).toBe(main.findRoot(worktree));
    expect(findRoot(fixture)).toBe(main.findRoot(fixture));
    same(project);
    same(join(project, 'src'));
    same(worktree);
    same(fixture);

    mkdirSync(join(project, '.agents'), { recursive: true });
    copyFileSync(example, join(project, '.agents', 'team.yaml'));
    same(worktree);
    same(project, { file: join(project, '.agents', 'team.yaml') });

    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 2\n');
    same(join(project, 'src'));

    const parent = fixture.split('/').pop() as string;
    const text = readFileSync(example, 'utf8')
      .replace('  - ../worktrees/acme-web/*', `  - ../../${parent}/*`)
      .replace('path: ../worktrees/{repo}/{task}', `path: ../../${parent}/{task}`);
    writeFileSync(join(project, '.agents', 'team.yaml'), text);
    same(project);

    symlinkSync(fixture, join(fixture, 'alias'));
    const linked = readFileSync(example, 'utf8').replace(
      '  - ../worktrees/acme-web/*',
      '  - ../worktrees/acme-web/*\n  - ../alias/*',
    );
    writeFileSync(join(project, '.agents', 'team.yaml'), linked);
    same(project);

    // A nested file is the case that is not extended: the git root's file, missing here, wins.
    mkdirSync(join(project, 'nested', '.agents'), { recursive: true });
    copyFileSync(example, join(project, 'nested', '.agents', 'team.yaml'));
    rmSync(join(project, '.agents', 'team.yaml'));
    same(join(project, 'nested'));
    const nested = loadTeamFile(join(project, 'nested'));
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.path).toBe(join(project, '.agents', 'team.yaml'));
  } finally {
    rmSync(archive, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
