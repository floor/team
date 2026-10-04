import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { skeleton } from '../src/commands/init.ts';
import { version } from '../src/version.ts';

const repo = join(import.meta.dir, '..');

test('the schema URL names the version the CLI reports', () => {
  const line = skeleton('demo', null).split('\n')[0] ?? '';
  expect(line).toBe(`# yaml-language-server: $schema=https://raw.githubusercontent.com/floor/team/v${version()}/schema/team.schema.json`);
});

test('the built CLI prints the same version the schema URL names', () => {
  // A clean checkout has no dist yet; build it rather than skip, so this test can never
  // pass vacuously where it matters most.
  if (!existsSync(join(repo, 'dist', 'cli.js'))) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: repo, encoding: 'utf8' });
    expect(build.status).toBe(0);
  }
  const run = spawnSync('node', [join(repo, 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(`${version()}\n`);
});
