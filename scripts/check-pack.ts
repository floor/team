// Fails when the packed tarball carries an internal ticket reference.
//
// A tarball is public the moment it is published, so nothing in it may name an
// internal ticket. Every member is read; a hit names the file, never the
// reference, so a failure cannot put one into public CI logs. An extraction or
// read error exits 2 — a check that cannot read the tarball must not report it
// clean.
//
//   bun scripts/check-pack.ts <tarball>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const INTERNAL_ID = /FLO-[0-9]+/;

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

const tarball = process.argv[2];
if (!tarball) {
  exit('usage: bun scripts/check-pack.ts <tarball>', 2);
}

const root = mkdtempSync(join(tmpdir(), 'team-check-pack-'));
const hits: string[] = [];
let problem: string | undefined;

try {
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', root]);
  if (tar.error !== undefined) {
    problem = `cannot extract ${tarball}: ${tar.error.message}`;
  } else if (tar.status !== 0) {
    const detail = tar.stderr.toString().trim();
    problem = `cannot extract ${tarball}: ${detail === '' ? `tar exited ${String(tar.status)}` : detail}`;
  } else {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (INTERNAL_ID.test(readFileSync(path, 'utf8'))) {
          hits.push(relative(root, path));
        }
      }
    };
    walk(root);
  }
} catch (error) {
  problem = (error as Error).message;
}

rmSync(root, { recursive: true, force: true });

if (problem !== undefined) {
  exit(`check-pack: ${problem}`, 2);
}
if (hits.length > 0) {
  exit(`The tarball carries an internal ticket reference:\n${hits.join('\n')}`, 1);
}

console.log('check-pack: no internal ticket reference in the tarball');
