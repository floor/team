import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');

const areas: string[] = [];

function area(): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-release-date-test-'));
  areas.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of areas.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the script in a fresh folder against `changelog`, or against no CHANGELOG.md at all. */
function run(changelog: string | undefined, version: string): { status: number | null; output: string } {
  const dir = area();
  if (changelog !== undefined) {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  }
  const result = spawnSync('bun', [join(repo, 'scripts', 'check-release-date.ts'), version], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const section = (version: string, date: string): string =>
  `# Changelog\n\n## [Unreleased]\n\n## [${version}] - ${date}\n\n### Added\n\n- A thing.\n`;

test('a real date passes', () => {
  const result = run(section('0.1.1', '2026-10-05'), '0.1.1');
  expect(result.status).toBe(0);
  expect(result.output).toContain('0.1.1 is dated 2026-10-05');
});

test('the YYYY-MM-DD placeholder fails, exit 1', () => {
  const result = run(section('0.1.1', 'YYYY-MM-DD'), '0.1.1');
  expect(result.status).toBe(1);
  expect(result.output).toContain('carries no real date');
});

test('a date that does not exist fails, exit 1', () => {
  const result = run(section('0.1.1', '2026-02-30'), '0.1.1');
  expect(result.status).toBe(1);
  expect(result.output).toContain('carries no real date');
});

test('a section for another version only is a missing section, exit 1', () => {
  const result = run(section('0.1.1', '2026-10-05'), '0.1.2');
  expect(result.status).toBe(1);
  expect(result.output).toContain('has no section for 0.1.2');
});

test('a missing CHANGELOG.md exits 2', () => {
  const result = run(undefined, '0.1.1');
  expect(result.status).toBe(2);
  expect(result.output).toContain('cannot read CHANGELOG.md');
});
