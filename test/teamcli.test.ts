import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCaller } from '../src/caller.ts';

const repo = join(import.meta.dir, '..');

function readJson(path: string): { version: string; dependencies?: { team?: string } } {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('teamcli is the same version as team, and depends on that exact version', () => {
  const root = readJson(join(repo, 'package.json'));
  const teamcli = readJson(join(repo, 'packages/teamcli/package.json'));
  expect(teamcli.version).toBe(root.version);
  expect(teamcli.dependencies?.team).toBe(root.version);
});

test('the teamcli tarball lists exactly the package manifest, the shim and the readme', () => {
  const dest = mkdtempSync(join(tmpdir(), 'teamcli-pack-'));
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: join(repo, 'packages/teamcli'),
    encoding: 'utf8',
  });
  expect(packed.status).toBe(0);
  const report = JSON.parse(packed.stdout)[0];
  const tarball = join(dest, report.filename);
  const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  expect(listed.status).toBe(0);
  expect(listed.stdout.trim().split('\n').sort()).toEqual([
    'package/README.md',
    'package/cli.js',
    'package/package.json',
  ]);
});

// The published manifest exports only ".". This test builds a package with that map
// rather than packing the tagged tree, then installs this branch's own tarball too.
function publishedTeam(dest: string): string {
  const dir = join(dest, 'published-team');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'team',
    version: '0.2.1',
    type: 'module',
    bin: { team: 'dist/cli.js' },
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist'],
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'dist/index.js'), 'export {};\n');
  writeFileSync(join(dir, 'dist/cli.js'), '#!/usr/bin/env node\nconsole.log("published-line");\n');
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], { cwd: dir, encoding: 'utf8' });
  expect(packed.status).toBe(0);
  return join(dest, JSON.parse(packed.stdout)[0].filename);
}

function installPair(prefix: string, teamTarball: string, teamcliTarball: string): void {
  const installed = spawnSync(
    'npm',
    ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', teamTarball, teamcliTarball],
    { cwd: prefix, encoding: 'utf8', timeout: 40_000 },
  );
  if (installed.status !== 0) {
    throw new Error(`npm install exited ${installed.status} ${installed.signal ?? ''}: ${installed.stderr || installed.stdout}`);
  }
}

test('packed team and teamcli bins match the team cli, and a signal reaches the child', async () => {
  const built = spawnSync('bun', ['run', 'build'], { cwd: repo, encoding: 'utf8', timeout: 40_000 });
  expect(built.status).toBe(0);

  const dest = mkdtempSync(join(tmpdir(), 'teamcli-bins-'));
  const rootPack = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], { cwd: repo, encoding: 'utf8' });
  expect(rootPack.status).toBe(0);
  const rootReport = JSON.parse(rootPack.stdout)[0];
  const rootPaths: string[] = rootReport.files.map((file: { path: string }) => file.path);
  expect(rootPaths.some((path) => path === 'packages' || path.startsWith('packages/'))).toBe(false);
  const teamcliPack = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: join(repo, 'packages/teamcli'),
    encoding: 'utf8',
  });
  expect(teamcliPack.status).toBe(0);
  const teamcliReport = JSON.parse(teamcliPack.stdout)[0];

  const teamcliTarball = join(dest, teamcliReport.filename);
  const published = mkdtempSync(join(tmpdir(), 'teamcli-published-'));
  installPair(published, publishedTeam(mkdtempSync(join(tmpdir(), 'teamcli-published-pack-'))), teamcliTarball);
  const publishedRun = spawnSync(join(published, 'node_modules/.bin/teamcli'), [], { encoding: 'utf8' });
  expect(publishedRun.status).toBe(0);
  expect(publishedRun.stdout).toBe('published-line\n');

  const prefix = mkdtempSync(join(tmpdir(), 'teamcli-prefix-'));
  installPair(prefix, join(dest, rootReport.filename), teamcliTarball);

  const own = spawnSync(process.execPath, [join(repo, 'dist/cli.js'), '--version'], { encoding: 'utf8' });
  const team = spawnSync(join(prefix, 'node_modules/.bin/team'), ['--version'], { encoding: 'utf8' });
  const teamcli = spawnSync(join(prefix, 'node_modules/.bin/teamcli'), ['--version'], { encoding: 'utf8' });
  expect(own.status).toBe(0);
  expect(team.stdout).toBe(own.stdout);
  expect(teamcli.stdout).toBe(own.stdout);

  const unknownOwn = spawnSync(process.execPath, [join(repo, 'dist/cli.js'), 'nosuch'], { encoding: 'utf8' });
  const unknownCli = spawnSync(join(prefix, 'node_modules/.bin/teamcli'), ['nosuch'], { encoding: 'utf8' });
  expect(unknownCli.status).toBe(unknownOwn.status);
  expect(unknownCli.stderr).toBe(unknownOwn.stderr);

  const child = spawn(join(prefix, 'node_modules/.bin/teamcli'), ['conformance-adapter'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill('SIGTERM');
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    }),
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      setTimeout(() => resolve({ code: null, signal: null }), 3000);
    }),
  ]);
  expect(exit.signal).toBe('SIGTERM');
}, 90_000);

test('a node parent is still the owner', () => {
  const judge = (names: string[], stdinIsTTY: boolean) => walkCaller({
    env: {},
    stdinIsTTY,
    callerSources: () => ({
      ancestors: () => names.map((name, index) => ({ pid: index + 2, name })),
      agents: () => [],
      paneRootPid: () => null,
      env: {},
      stdinIsTTY,
    }),
  });
  expect(judge(['zsh'], true)).toEqual({ kind: 'owner' });
  expect(judge(['node', 'zsh'], true)).toEqual({ kind: 'owner' });
  expect(judge(['claude', 'zsh'], true)).toEqual({
    kind: 'unplaced',
    reason: 'it is run by an agent (claude) outside herdr',
  });
  expect(judge(['node', 'zsh'], false)).toEqual({
    kind: 'unplaced',
    reason: 'it doesn\'t run on a terminal',
  });
});
