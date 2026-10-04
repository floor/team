import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');

test('package.json files includes schema and allowed entries only', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  expect(pkg.files).toContain('schema');
  expect(pkg.files).toEqual(['dist', 'examples', 'schema', 'README.md', 'LICENSE']);
  expect(pkg.files).not.toContain('contract');
  expect(pkg.files).not.toContain('test');
});

test('schema/team.schema.json exists and is valid JSON', () => {
  const schemaPath = join(repo, 'schema', 'team.schema.json');
  expect(existsSync(schemaPath)).toBe(true);
  const parsed = JSON.parse(readFileSync(schemaPath, 'utf8'));
  expect(parsed.$schema).toBeDefined();
});

test('npm pack includes schema/team.schema.json and no forbidden folders', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: repo, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);

  // If dist has been built, the clean entry count is pinned to 222; otherwise the 6 non-dist entries
  const distDir = join(repo, 'dist');
  const hasDist = existsSync(distDir) && readdirSync(distDir).length > 0;
  expect(json[0]?.entryCount).toBe(hasDist ? 222 : 6);

  const files: { path: string }[] = json[0]?.files ?? [];
  const paths = files.map((f) => f.path);

  // Schema must be shipped in the package
  expect(paths).toContain('schema/team.schema.json');

  // No unexpected top-level folder may enter the package
  const allowedPrefixes = ['dist/', 'examples/', 'schema/', 'README.md', 'LICENSE', 'package.json'];
  for (const path of paths) {
    const isAllowed = allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));
    expect(isAllowed).toBe(true);
  }
  expect(paths.some((p) => p.startsWith('contract/'))).toBe(false);
  expect(paths.some((p) => p.startsWith('test/'))).toBe(false);
  expect(paths.some((p) => p.startsWith('scripts/'))).toBe(false);
  expect(paths.some((p) => p.startsWith('.github/'))).toBe(false);
});

