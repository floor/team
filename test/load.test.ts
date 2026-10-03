import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRoot, loadTeamFile } from '../src/file/load.ts';

const example = new URL('./fixtures/example.yaml', import.meta.url).pathname;
let base: string;
let project: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
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
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/not inside a git repository/);
  });
});
