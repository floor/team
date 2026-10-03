import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeMerge, readMerge } from '../src/end/condition.ts';

describe('merged, from the branch\'s own commits', () => {
  test('a fresh branch, one only brought up to date, and a real merge', () => {
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: [], ownBefore: false }).verdict).toBe('open');
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: [], ownBefore: false }).detail).toContain('never had');
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: ['abc own'], ownBefore: true }).verdict).toBe('open');
    expect(judgeMerge({ fetch: 'ok', branch: 'present', ownNow: [], ownBefore: true }).verdict).toBe('merged');
  });

  test('a failed fetch or a deleted branch removes nothing', () => {
    expect(judgeMerge({ fetch: 'failed', branch: 'present', ownNow: [], ownBefore: true }).verdict).toBe('unproven');
    expect(judgeMerge({ fetch: 'ok', branch: 'gone', ownNow: [], ownBefore: true }).detail).toContain('squash');
  });
});

describe('read from a repository', () => {
  let base: string;
  let project: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function setup(): void {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-end-')));
    project = join(base, 'acme');
    const remote = join(base, 'remote.git');
    mkdirSync(project);
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'Test');
    git(project, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(project, 'README.md'), 'acme\n');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'first');
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'push', '-q', '-u', 'origin', 'main');
  }

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test('a fresh branch and one that was only fast-forwarded are not merged', () => {
    setup();
    git(project, 'branch', 'fix/fresh');
    expect(readMerge(project, 'fix/fresh', 'main', false)).toMatchObject({ verdict: 'open', ownNow: 0 });
    git(project, 'commit', '-q', '--allow-empty', '-m', 'later');
    git(project, 'push', '-q', 'origin', 'main');
    git(project, 'branch', 'fix/updated', 'HEAD~1');
    git(project, 'checkout', '-q', 'fix/updated');
    git(project, 'merge', '-q', '--ff-only', 'origin/main');
    expect(readMerge(project, 'fix/updated', 'main', false).detail).toContain('never had');
  });

  test('a merge of the branch\'s own commit is merged only after it was seen', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/own');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'own');
    expect(readMerge(project, 'fix/own', 'main', false)).toMatchObject({ verdict: 'open', ownNow: 1 });
    git(project, 'checkout', '-q', 'main');
    git(project, 'merge', '-q', '--no-ff', 'fix/own', '-m', 'merge own');
    git(project, 'push', '-q', 'origin', 'main');
    expect(readMerge(project, 'fix/own', 'main', false).verdict).toBe('open');
    expect(readMerge(project, 'fix/own', 'main', true).verdict).toBe('merged');
  });

  test('a squash leaves the branch\'s commits in place, so it is not merged', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/squash');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'own');
    git(project, 'checkout', '-q', 'main');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'squashed');
    git(project, 'push', '-q', 'origin', 'main');
    expect(readMerge(project, 'fix/squash', 'main', true)).toMatchObject({
      verdict: 'open',
      ownNow: 1,
      detail: 'merged? not provable',
    });
  });

  test('a branch whose tree still differs is open, and stays quiet', () => {
    setup();
    git(project, 'checkout', '-q', '-b', 'fix/open');
    writeFileSync(join(project, 'README.md'), 'changed\n');
    git(project, 'commit', '-q', '-am', 'own');
    expect(readMerge(project, 'fix/open', 'main', true)).toMatchObject({
      verdict: 'open',
      ownNow: 1,
      detail: 'the branch still has commits of its own',
    });
  });

  test('a deleted branch and a failed fetch are unproven', () => {
    setup();
    git(project, 'branch', 'fix/gone');
    git(project, 'push', '-q', 'origin', 'fix/gone');
    git(project, 'branch', '-D', 'fix/gone');
    git(project, 'push', '-q', 'origin', ':fix/gone');
    expect(readMerge(project, 'fix/gone', 'main', true).verdict).toBe('unproven');
    git(project, 'remote', 'set-url', 'origin', join(base, 'missing.git'));
    expect(readMerge(project, 'main', 'main', true).detail).toContain('fetch failed');
  });
});
