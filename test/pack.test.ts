import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');

test('package.json files includes schema directory', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  expect(pkg.files).toContain('schema');
});

test('npm pack includes schema/team.schema.json', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: repo, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const json = JSON.parse(result.stdout);
  const files: { path: string }[] = json[0]?.files ?? [];
  const paths = files.map((f) => f.path);
  expect(paths).toContain('schema/team.schema.json');
});
