import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');

test('package.json files allows the shipped entries only', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  expect(pkg.files).toEqual(['dist', 'examples', 'schema', 'README.md', 'LICENSE']);
});

test('the packed tarball ships the schema and nothing it should not', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: repo, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const files: { path: string }[] = JSON.parse(result.stdout)[0]?.files ?? [];
  expect(files.length).toBeGreaterThan(0);
  const paths = files.map((f) => f.path);

  // Required in every package, and the CLI itself whenever dist has been built.
  for (const required of ['schema/team.schema.json', 'package.json', 'README.md', 'LICENSE']) {
    expect(paths).toContain(required);
  }
  if (existsSync(join(repo, 'dist'))) {
    expect(paths).toContain('dist/cli.js');
  }

  // Every packed path under the allowed top-level entries…
  const allowed = ['dist/', 'examples/', 'schema/', 'package.json', 'README.md', 'LICENSE'];
  for (const path of paths) {
    expect(allowed.some((prefix) => path === prefix || path.startsWith(prefix))).toBe(true);
  }
  // …and the folders that must never ship stay absent.
  for (const forbidden of ['contract/', 'test/', 'scripts/', '.github/', 'docs/', 'src/']) {
    expect(paths.some((p) => p.startsWith(forbidden))).toBe(false);
  }
});

test('the schema is tracked at HEAD, so a tag of this commit ships the URL init writes', () => {
  // `team init` writes a $schema URL pinned to this release's tag; the guard belongs with
  // the pack tests because it is the same promise, made to the tarball's future tags.
  const result = spawnSync('git', ['-C', repo, 'ls-tree', '-r', 'HEAD', '--', 'schema/team.schema.json'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split('\n').filter((line) => line !== '');
  expect(lines.length).toBe(1);
  expect(lines[0]?.endsWith('schema/team.schema.json')).toBe(true);
});
