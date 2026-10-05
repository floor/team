#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// The published package exports only its main entry. Resolve that file, then the
// nearest manifest named team, and stop at node_modules so a manifest above the
// package is never read.
function teamPackage(entry) {
  let dir = dirname(entry);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'team') return { dir, pkg };
    } catch {
      // This directory has no manifest. The parent might.
    }
    const parent = dirname(dir);
    if (basename(parent) === 'node_modules' || parent === dir) return null;
    dir = parent;
  }
}

const found = teamPackage(require.resolve('team'));
if (!found) {
  process.stderr.write('teamcli: the team package could not be found\n');
  process.exit(1);
}
const bin = typeof found.pkg.bin === 'string' ? found.pkg.bin : found.pkg.bin?.team;
if (typeof bin !== 'string') {
  process.stderr.write('teamcli: the team package does not name a team bin\n');
  process.exit(1);
}

const child = spawn(join(found.dir, bin), process.argv.slice(2), { stdio: 'inherit' });
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const forward = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
for (const [signal, handler] of forward) process.on(signal, handler);

child.on('error', (error) => {
  process.stderr.write(`teamcli: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  for (const [name, handler] of forward) process.removeListener(name, handler);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
