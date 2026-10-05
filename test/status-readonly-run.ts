// `status` is a read. This runs it against a stand-in herdr whose writing functions fail the run
// if they are called at all, records every call the readers make, and prints the report and the
// record. Run as its own process so the stand-in is in place before the command loads.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realHerdr from '../src/herdr.ts';

const calls: string[] = [];
const writer = (name: string) => (): never => {
  calls.push(name);
  throw new Error(`status called ${name}`);
};

const IDLE = readFileSync(new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8');

mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunning: (session: string) => {
    calls.push(`sessionRunning ${session}`);
    return true;
  },
  agentList: (session: string) => {
    calls.push(`agentList ${session}`);
    return [
      { name: 'lead', agent: 'claude', pane: '%1', workspace: 'w1', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: '%2', workspace: 'w2', status: 'idle', cwd: null },
    ];
  },
  workspaceList: (session: string) => {
    calls.push(`workspaceList ${session}`);
    return [{ id: 'w1', label: 'lead' }, { id: 'w2', label: 'worker' }];
  },
  paneRead: (pane: string, lines: number, session?: string) => {
    calls.push(`paneRead ${pane} ${lines} ${session}`);
    return IDLE;
  },
  typeText: writer('typeText'),
  pressEnter: writer('pressEnter'),
  paneRun: writer('paneRun'),
  agentRename: writer('agentRename'),
  workspaceCreate: writer('workspaceCreate'),
  workspaceClose: writer('workspaceClose'),
  startServer: writer('startServer'),
  sessionStop: writer('sessionStop'),
  sessionDelete: writer('sessionDelete'),
}));

const { realSources, runStatus } = await import('../src/commands/status.ts');
const { testIo } = await import('./helpers.ts');

const TEAM = `format: 1
project: acme
session: acme-web
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-status-ro-')));
const root = join(base, 'acme');
mkdirSync(join(root, '.agents'), { recursive: true });
const file = join(root, '.agents', 'team.yaml');
writeFileSync(file, TEAM);

const io = testIo(root);
const code = await runStatus(['--file', file], io, {
  // The real live read (the one under test); the store, the branch and the clock are stood in.
  live: realSources.live,
  branch: () => null,
  standing: () => ({ kind: 'none' as const }),
  now: () => new Date('2026-10-04T09:00:00Z'),
});
console.log(JSON.stringify({ code, err: io.err, out: io.out, calls }));
rmSync(base, { recursive: true, force: true });
