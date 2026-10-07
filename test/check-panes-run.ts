// The check's own live read (§3.3a) is the one narrow pass over panes this project's state
// records for this team's seats. The narrowing is per seat, not per pane id: a recorded pane id
// since reused by an agent that is not the seat it is recorded for buys no screen read, and the
// pane still standing where a launched seat left it is read anyway, to tell gone from replaced.
// This runs the real `realCheckSources.live` against a stand-in herdr that records every call it
// makes, over one state per case, and prints the runs. Its own process, so the stand-in is in
// place before the command loads.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realHerdr from '../src/herdr.ts';

const calls: string[] = [];
const writer = (name: string) => (): never => {
  calls.push(name);
  throw new Error(`check called ${name}`);
};

const IDLE = readFileSync(new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8');

// One agent, `guest`, on pane %9 of workspace w9 — under no name this team's file seats.
mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunning: (session: string) => {
    calls.push(`sessionRunning ${session}`);
    return true;
  },
  agentList: (session: string) => {
    calls.push(`agentList ${session}`);
    return [{ name: 'guest', agent: 'claude', pane: '%9', workspace: 'w9', status: 'idle', cwd: null }];
  },
  workspaceList: (session: string) => {
    calls.push(`workspaceList ${session}`);
    return [{ id: 'w9', label: 'guest' }];
  },
  paneRead: (pane: string, lines: number, session?: string) => {
    calls.push(`paneRead ${pane} ${lines} ${session}`);
    return IDLE;
  },
  paneProcesses: (pane: string, session?: string) => {
    calls.push(`paneProcesses ${pane} ${session}`);
    return { shell: 9200, foreground: [9300] };
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

const { check, loadConfig } = await import('../src/commands/check.ts');
const { realCheckSources } = await import('../src/check/team.ts');
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
    stopped: true
`;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-panes-')));
const root = join(base, 'acme');
mkdirSync(join(root, '.agents'), { recursive: true });
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);

const sources = {
  // The real live read, the one under test; the store, the branch and the clock are stood in.
  ...realCheckSources,
  branch: () => null,
  standing: () => ({ kind: 'none' as const }),
  now: () => new Date('2026-10-04T09:00:00Z'),
  home: base,
};

async function run(seats: Record<string, unknown>) {
  writeFileSync(join(root, '.agents', 'team.state.json'), JSON.stringify({ format: 1, sessions: { 'acme-web': { seats } } }));
  calls.length = 0;
  const io = testIo(root, { kind: 'owner' });
  const code = await check([], io, (cwd, file) => loadConfig(cwd, file, base), sources);
  return { code, err: io.err, out: io.out, calls: [...calls] };
}

// One: lead is recorded on %9 but was never launched, and %9 is listed under `guest`: the seat
// is missing — and nothing may read %9, which is a stranger's screen today.
const one = await run({ lead: { stage: 'ready', pane: '%9' } });
// Two: the same pairing, but the record says team launched a CLI in %9. The pane still stands
// where the seat was launched, so it is read — and the reading is what says the process there is
// not the one team launched.
const two = await run({ lead: { stage: 'launched', pane: '%9', launched: { shell: 4000, cli: [4100] } } });

console.log(JSON.stringify({ one, two }));
rmSync(base, { recursive: true, force: true });
