// Evidence for the bare-shell close: `down` and `remove` against a recorded seat whose CLI has
// exited. The script creates its own herdr sessions — one seat each, launched as a fake CLI
// (`exec -a claude`, the argv0 claude-code's profile matches, so herdr lists it as the seat's
// CLI) — reads the pane's process identity through the shipped readers (foreground argv0s,
// whether the pane's own shell process is back in front), then drives the real commands
// in-process and prints every reading as JSON.
//
// Run before the change (`base`) to see today's refusals on the same fixture, and after it
// (`fixed`) to see the closes:
//
//   bun test/down-bare-shell-run.ts base
//   bun test/down-bare-shell-run.ts fixed
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { approvalOf } from '../src/approve/approval.ts';
import { runDown, realSources as downReal, paneStillRunning } from '../src/commands/down.ts';
import { runRemove, realSources as removeReal } from '../src/commands/remove.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  agentList,
  agentRename,
  paneForeground,
  paneProcesses,
  paneRead,
  paneRun,
  paneShellBack,
  sessionState,
  workspaceCreate,
  workspaceList,
} from '../src/herdr.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { readScreen } from '../src/watch/screen.ts';
import { testIo } from './helpers.ts';

const MODE = process.argv[2] ?? 'fixed';
if (MODE !== 'base' && MODE !== 'fixed') throw new Error('usage: bun test/down-bare-shell-run.ts base|fixed');

const SESSION_DOWN = 'down-bare-shell';
const SESSION_REMOVE = 'remove-bare-shell';
const CLI = 'claude';
const FAKE = `bash -c 'exec -a ${CLI} sleep 300'`;
const NOW = new Date('2026-10-08T09:00:00Z');

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(what: string, ready: () => boolean): void {
  const start = Date.now();
  for (;;) {
    if (ready()) return;
    if (Date.now() - start > 20_000) throw new Error(`timed out waiting for ${what}`);
    pause(200);
  }
}

function waitReady(session: string): void {
  waitFor('the scratch server to answer', () => workspaceList(session) !== null);
}

type Fixture = { base: string; root: string; home: string; file: string };

function fixture(tag: string, session: string): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `team-down-bare-shell-${tag}-`)));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const file = join(root, '.agents', 'team.yaml');
  const text = `format: 1
project: acme
session: ${session}
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
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
  writeFileSync(file, text);
  const checked = validateTeamFile(text, { home, root });
  if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
  writeApproval(storePath(checked.team.project, root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, [], home);
  return { base, root, home, file };
}

/** One scratch seat: a workspace, the fake CLI typed into its pane, the pane renamed to the
 *  seat's name — herdr's own rename, the same call `team up` makes. */
function launchSeat(session: string, fx: Fixture, name: string): { pane: string; workspace: string } {
  const made = workspaceCreate(fx.root, name, session);
  if (!made) throw new Error('the scratch workspace was not created');
  if (!paneRun(made.pane, FAKE, session)) throw new Error('the fake CLI was not typed into the pane');
  waitFor('the fake CLI to be listed', () =>
    (agentList(session) ?? []).some((agent) => agent.pane === made.pane && agent.agent === CLI));
  if (!agentRename(made.pane, name, session)) throw new Error('the pane was not renamed to the seat');
  waitFor(`the seat ${name} to be listed`, () =>
    (agentList(session) ?? []).some((agent) => agent.pane === made.pane && agent.name === name));
  return made;
}

type Reading = {
  foreground: string[] | null;
  stillRunning: boolean;
  shellBack: boolean | null;
  screen: string;
  agents: { name: string | null; agent: string | null; status: string }[];
};

function read(session: string, pane: string, home: string): Reading {
  const foreground = paneForeground(pane, session);
  return {
    foreground,
    stillRunning: paneStillRunning(foreground, [CLI]),
    shellBack: paneShellBack(pane, session),
    screen: readScreen('claude-code', paneRead(pane, 200, session) ?? undefined, { home }).kind,
    agents: (agentList(session) ?? []).map((agent) => ({ name: agent.name, agent: agent.agent, status: agent.status })),
  };
}

/** Ends the fake CLI the way its own process would end: SIGTERM to the pane's foreground pid
 *  that is not the pane's own shell. Returns the pid, for the evidence. */
function endCli(session: string, pane: string): number {
  let pid: number | undefined;
  waitFor('the pane processes to be readable', () => {
    const processes = paneProcesses(pane, session);
    if (processes === null) return false;
    pid = processes.foreground.find((each) => each !== processes.shell);
    return pid !== undefined;
  });
  if (pid === undefined) throw new Error('the pane has no foreground process but its shell');
  process.kill(pid, 'SIGTERM');
  return pid;
}

const servers: ChildProcess[] = [];
const fixtures: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const report: Record<string, unknown> = { mode: MODE };

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function start(session: string): void {
  servers.push(spawn('herdr', ['--session', session, 'server'], { stdio: 'ignore' }));
  waitReady(session);
}

const DOWN_REFUSAL = 'worker: shows a screen the profile does not recognise; left running\n';
const DOWN_LEFT = `session ${SESSION_DOWN}: not stopped, 1 agent left in it\n`;
const REMOVE_REFUSAL = 'team remove: worker shows a screen the profile does not recognise; left as it is (team remove worker --abandon closes its workspace without typing)\n';

try {
  // ---- down: the CLI running (the negative pin), then exited ------------------------------
  const downFx = fixture('down', SESSION_DOWN);
  fixtures.push(downFx.base);
  start(SESSION_DOWN);
  const downSeat = launchSeat(SESSION_DOWN, downFx, 'worker');

  const live = read(SESSION_DOWN, downSeat.pane, downFx.home);
  const ioLive = testIo(downFx.root, { kind: 'owner' });
  const codeLive = await runDown([], ioLive, { ...downReal, home: downFx.home });
  const afterLive = sessionState(SESSION_DOWN);

  const ended = endCli(SESSION_DOWN, downSeat.pane);
  waitFor('the pane shell to come back', () => paneShellBack(downSeat.pane, SESSION_DOWN) === true);
  const exited = read(SESSION_DOWN, downSeat.pane, downFx.home);
  const ioExited = testIo(downFx.root, { kind: 'owner' });
  const codeExited = await runDown([], ioExited, { ...downReal, home: downFx.home });
  const afterExited = sessionState(SESSION_DOWN);
  report.down = {
    live, codeLive, outLive: ioLive.out, errLive: ioLive.err, afterLive,
    ended, exited, codeExited, outExited: ioExited.out, errExited: ioExited.err, afterExited,
  };

  check(
    'down: a live CLI on an unreadable screen is refused as today',
    live.foreground?.includes(CLI) === true && live.stillRunning && live.shellBack === false
      && codeLive === 0 && ioLive.out.includes(DOWN_REFUSAL) && ioLive.out.includes(DOWN_LEFT) && afterLive === 'running',
    `exit ${codeLive}, session ${afterLive}, foreground ${JSON.stringify(live.foreground)}, shellBack ${live.shellBack}`,
  );
  check(
    'down: the exited pane reads no CLI process and its own shell in front',
    exited.foreground?.includes(CLI) === false && exited.stillRunning === false && exited.shellBack === true,
    `foreground ${JSON.stringify(exited.foreground)}, shellBack ${exited.shellBack}, screen ${exited.screen}`,
  );
  if (MODE === 'base') {
    check(
      'down (base): the bare shell is refused, exit 0, session not stopped',
      codeExited === 0 && ioExited.out.includes(DOWN_REFUSAL) && ioExited.out.includes(DOWN_LEFT) && afterExited === 'running',
      `exit ${codeExited}, session ${afterExited}`,
    );
  } else {
    check(
      'down: one run closes the exited seat and stops the team',
      codeExited === 0 && ioExited.out.includes('worker: its CLI had exited; its workspace was closed\n')
        && ioExited.out.includes(`session ${SESSION_DOWN}: stopped and cleared\n`) && afterExited === 'absent'
        && !ioExited.out.includes('does not recognise'),
      `exit ${codeExited}, session ${afterExited}`,
    );
  }

  // ---- remove: the CLI running (the negative pin), then exited ---------------------------
  const removeFx = fixture('remove', SESSION_REMOVE);
  fixtures.push(removeFx.base);
  start(SESSION_REMOVE);
  const removeSeat = launchSeat(SESSION_REMOVE, removeFx, 'worker');

  const liveR = read(SESSION_REMOVE, removeSeat.pane, removeFx.home);
  const ioLiveR = testIo(removeFx.root, { kind: 'owner' });
  const codeLiveR = await runRemove(['worker'], ioLiveR, { ...removeReal, home: removeFx.home });
  const keptLive = readFileSync(removeFx.file, 'utf8').includes('name: worker');

  const endedR = endCli(SESSION_REMOVE, removeSeat.pane);
  waitFor('the pane shell to come back', () => paneShellBack(removeSeat.pane, SESSION_REMOVE) === true);
  const exitedR = read(SESSION_REMOVE, removeSeat.pane, removeFx.home);
  const ioExitedR = testIo(removeFx.root, { kind: 'owner' });
  const codeExitedR = await runRemove(['worker'], ioExitedR, { ...removeReal, home: removeFx.home });
  const keptExited = readFileSync(removeFx.file, 'utf8').includes('name: worker');
  const workspacesLive = workspaceList(SESSION_REMOVE);
  const workspacesExited = workspaceList(SESSION_REMOVE);
  report.remove = {
    live: liveR, codeLive: codeLiveR, outLive: ioLiveR.out, errLive: ioLiveR.err, keptLive,
    workspaceLive: workspacesLive,
    ended: endedR, exited: exitedR, codeExited: codeExitedR, outExited: ioExitedR.out, errExited: ioExitedR.err,
    keptExited, workspacesExited, sessionExited: sessionState(SESSION_REMOVE),
  };

  check(
    'remove: a live CLI on an unreadable screen is refused as today',
    codeLiveR === 1 && ioLiveR.err === REMOVE_REFUSAL && keptLive,
    `exit ${codeLiveR}, seat kept ${keptLive}`,
  );
  check(
    'remove: the exited pane reads no CLI process and its own shell in front',
    exitedR.foreground?.includes(CLI) === false && exitedR.stillRunning === false && exitedR.shellBack === true,
    `foreground ${JSON.stringify(exitedR.foreground)}, shellBack ${exitedR.shellBack}, screen ${exitedR.screen}`,
  );
  if (MODE === 'base') {
    check(
      'remove (base): the bare shell is refused, the seat stays in the file',
      codeExitedR === 1 && ioExitedR.err === REMOVE_REFUSAL && keptExited
        && workspacesLive !== null && workspacesLive.some((ws) => ws.id === removeSeat.workspace),
      `exit ${codeExitedR}, seat kept ${keptExited}, workspace ${JSON.stringify(removeSeat.workspace)} in ${JSON.stringify(workspacesLive)}`,
    );
  } else {
    check(
      'remove: one run closes the exited seat, removes it, and says so on its line',
      codeExitedR === 0 && ioExitedR.out.includes('worker: its CLI had exited; its workspace was closed\n')
        && ioExitedR.out.includes('removed worker\n') && !keptExited
        && workspacesExited !== null && !workspacesExited.some((ws) => ws.id === removeSeat.workspace),
      `exit ${codeExitedR}, seat kept ${keptExited}, workspaces ${JSON.stringify(workspacesExited)}`,
    );
  }
} finally {
  for (const session of [SESSION_DOWN, SESSION_REMOVE]) {
    try {
      execFileSync('herdr', ['session', 'stop', session], { stdio: 'ignore' });
    } catch { /* already stopped */ }
    try {
      execFileSync('herdr', ['session', 'delete', session], { stdio: 'ignore' });
    } catch { /* already gone */ }
  }
  for (const server of servers) {
    try {
      server.kill();
    } catch { /* the session stop owns the process */ }
  }
  for (const base of fixtures) rmSync(base, { recursive: true, force: true });
}

report.checks = checks;
console.log(JSON.stringify(report, null, 2));
console.log(checks.map((each) => `${each.ok ? 'ok  ' : 'FAIL'} ${each.name} (${each.detail})`).join('\n'));
process.exitCode = checks.every((each) => each.ok) ? 0 : 1;
