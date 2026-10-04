import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');

test('package.json files includes schema directory', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  expect(pkg.files).toContain('schema');
});

test('npm pack includes schema/team.schema.json and pins clean entry count', () => {
  // Build from clean slate so pack count never depends on stale leftovers or a missing dist
  const build = spawnSync('bun', ['scripts/build.ts'], { cwd: repo, encoding: 'utf8' });
  expect(build.status).toBe(0);

  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: repo, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json[0]?.entryCount).toBe(222);

  const files: { path: string }[] = json[0]?.files ?? [];
  const paths = files.map((f) => f.path);
  expect(paths).toContain('schema/team.schema.json');

  // Must fail if an unexpected top-level folder such as contract/ or test/ enters the package
  const allowedPrefixes = ['dist/', 'examples/', 'schema/', 'README.md', 'LICENSE', 'package.json'];
  for (const path of paths) {
    const isAllowed = allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));
    expect(isAllowed).toBe(true);
  }
  expect(paths.some((p) => p.startsWith('contract/'))).toBe(false);
  expect(paths.some((p) => p.startsWith('test/'))).toBe(false);
});
