// `usage` reads files and runs nothing. This runs it in its own process, with a `readFileSync`
// and a child-process pair that record every path opened and every command spawned before
// delegating, and a herdr whose every function fails the run if it is called at all. The scratch
// home holds trap files where a CLI's own sessions and credentials would live: a read of one is
// `opened` naming it. Run as its own process so every stand-in is in place before the command
// loads.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realChild from 'node:child_process';
import * as realFs from 'node:fs';
import * as realHerdr from '../src/herdr.ts';

const opened: string[] = [];
const ran: string[] = [];
const note = (file: unknown, args?: unknown) => ran.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' '));

// The original functions, held before the mocks are installed: a mock factory that looked the
// namespace up again at call time would call itself.
const realRead = realFs.readFileSync.bind(realFs);
const realExecFile = realChild.execFileSync.bind(realChild);
const realExec = realChild.execSync.bind(realChild);
const realSpawnSync = realChild.spawnSync.bind(realChild);
const realSpawn = realChild.spawn.bind(realChild);

mock.module('node:fs', () => ({
  ...realFs,
  readFileSync: (path: Parameters<typeof realFs.readFileSync>[0], options?: Parameters<typeof realFs.readFileSync>[1]) => {
    opened.push(String(path));
    return realRead(path, options as never);
  },
}));

mock.module('node:child_process', () => ({
  ...realChild,
  execFileSync: (file: unknown, args: unknown, options: unknown) => {
    note(file, args);
    return realExecFile(file as never, args as never, options as never);
  },
  execSync: (command: unknown, options: unknown) => {
    ran.push(String(command));
    return realExec(command as never, options as never);
  },
  spawnSync: (file: unknown, args: unknown, options: unknown) => {
    note(file, args);
    return realSpawnSync(file as never, args as never, options as never);
  },
  spawn: (file: unknown, args: unknown, options: unknown) => {
    note(file, args);
    return realSpawn(file as never, args as never, options as never);
  },
}));

mock.module('../src/herdr.ts', () => {
  const mod: Record<string, unknown> = { ...realHerdr };
  for (const [name, value] of Object.entries(realHerdr)) {
    if (typeof value === 'function') {
      mod[name] = () => {
        throw new Error(`usage called herdr's ${name}`);
      };
    }
  }
  return mod;
});

const { approvalOf } = await import('../src/approve/approval.ts');
const { runUsage } = await import('../src/commands/usage.ts');
const { validateTeamFile } = await import('../src/file/validate.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { storePath, writeApproval } = await import('../src/store/store.ts');
const { testIo } = await import('./helpers.ts');

const NOW = new Date('2026-10-04T09:00:00Z');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-usage-traps-')));
const home = join(base, 'home');
const root = join(base, 'acme');
mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
mkdirSync(join(root, '.agents'), { recursive: true });

// The traps: a CLI's own sessions and credentials, where its defaults put them, none of them
// anything a reader may open. Their content is a marker no output may carry.
const TRAPS = [
  join(home, '.claude', 'projects', '-Users-acme', 'session.jsonl'),
  join(home, '.claude.json'),
  join(home, '.codex', 'auth.json'),
  join(home, '.codex', 'sessions', 'rollout-2026-10-04.jsonl'),
  join(home, '.cursor', 'cli-config.json'),
  join(home, '.gemini', 'oauth_creds.json'),
];
for (const trap of TRAPS) {
  mkdirSync(join(trap, '..'), { recursive: true });
  writeFileSync(trap, 'TRAP-MARKER');
}

const text = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [check, status_line]
      check: acme-quota
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const file = join(root, '.agents', 'team.yaml');
writeFileSync(file, text);
const checked = validateTeamFile(text, { home, root });
if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
writeApproval(storePath(checked.team.project, root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, [], home);

updateState(join(root, '.agents'), (state) => {
  state.budgets = {
    'openai/session': { account: 'openai', window: 'session', left: 40, used: 60, changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: null, source: 'check', confirmed: true },
  } as never;
  state.sessions['acme-web'] = emptySession() as never;
});

// The recorder is armed only after the fixture is built: what is under test is the command's
// own reads, not the fixture's writes.
opened.length = 0;
ran.length = 0;
const io = testIo(root, { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' });
const code = await runUsage(['--json'], io, { home, now: () => NOW });
console.log(JSON.stringify({ code, err: io.err, out: io.out, opened, ran, root, home, traps: TRAPS }));
rmSync(base, { recursive: true, force: true });
