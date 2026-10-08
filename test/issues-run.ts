// Evidence for `team issues`. The harness writes the YAML list. The command runs in a pane of a
// scratch herdr session this process creates, stops and deletes. The pane is a shell.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { findRoot } from '../src/file/load.ts';

const SESSION = 'issues-evidence';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const LIST = `- id: m1
  title: the task title
`;

function herdr(...args: string[]): string {
  return execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' }).trim();
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitReady(): void {
  const start = Date.now();
  for (;;) {
    try {
      execFileSync('herdr', ['--session', SESSION, 'workspace', 'list'], { stdio: 'ignore' });
      return;
    } catch {
      if (Date.now() - start > 20_000) throw new Error('the scratch server did not answer');
      pause(200);
    }
  }
}

function paneId(created: string): string {
  const match = created.match(/(?:pane\s+)?(%\d+|\w+:p\d+)/);
  if (match?.[1]) return match[1];
  const listed = herdr('pane', 'list');
  const ids = [...listed.matchAll(/(?:^|\s)(%\d+|[A-Za-z0-9_-]+:p\d+)\b/g)].map((item) => item[1] as string);
  const id = ids.at(-1);
  if (!id) throw new Error(`no pane id in:\n${created}\n${listed}`);
  return id;
}

const base = mkdtempSync(join(tmpdir(), 'team-issues-run-'));
const root = join(base, 'acme');
const home = join(base, 'home');
mkdirSync(join(root, '.agents'), { recursive: true });
mkdirSync(home);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
writeFileSync(join(root, '.agents', 'tasks.yaml'), LIST);
const checkout = findRoot(root);
if (!checkout) throw new Error('the evidence checkout has no root');

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const script = join(base, 'run.sh');
writeFileSync(script, `#!/bin/bash
cd ${JSON.stringify(root)} || exit 9
export HOME=${JSON.stringify(home)}
echo '--- list ---'
bun ${JSON.stringify(cli)} issues
echo "exit:$?"
printf '[]\\n' > .agents/tasks.yaml
echo '--- empty ---'
bun ${JSON.stringify(cli)} issues
echo "exit:$?"
echo '--- next ---'
bun ${JSON.stringify(cli)} next
echo "exit:$?"
echo '--- done ---'
`);

let server: ChildProcess | undefined;
try {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* none yet */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* none yet */ }
  server = spawn('herdr', ['--session', SESSION, 'server'], { stdio: 'ignore' });
  waitReady();
  const created = herdr('workspace', 'create', '--cwd', root, '--label', 'lead', '--no-focus');
  const pane = paneId(created);
  herdr('pane', 'run', pane, `bash ${JSON.stringify(script)}`);
  let glass = '';
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    glass = herdr('pane', 'read', pane, '--source', 'recent', '--lines', '80');
    if (glass.includes('--- done ---')) break;
    pause(300);
  }
  console.log(glass);
} finally {
  try { execFileSync('herdr', ['session', 'stop', SESSION], { stdio: 'ignore' }); } catch { /* already stopped */ }
  try { execFileSync('herdr', ['session', 'delete', SESSION], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { server?.kill(); } catch { /* the session stop owns the process */ }
  rmSync(base, { recursive: true, force: true });
}
