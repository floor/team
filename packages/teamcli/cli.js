#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('team/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.team;
if (typeof bin !== 'string') {
  process.stderr.write('teamcli: the team package does not name a team bin\n');
  process.exit(1);
}

const child = spawn(join(dirname(pkgPath), bin), process.argv.slice(2), { stdio: 'inherit' });
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
