import { execFileSync, spawn } from 'node:child_process';

// The only module that talks to herdr. Reading is the default. The calls that change a session
// are `startServer`, `workspaceCreate`, `paneRun`, `agentRename`, `workspaceClose`, `sessionStop`,
// `sessionDelete`, `typeText` and `pressEnter`. `team` deletes a session in one case only:
// `down` clears the session it has itself just stopped, in the same run; `up` never deletes one.

export type HerdrAgent = {
  name: string | null;
  agent: string | null;
  pane: string;
  workspace: string;
  status: string;
  cwd: string | null;
};

function run(args: string[], session?: string): unknown {
  const full = session ? ['--session', session, ...args] : args;
  const out = execFileSync('herdr', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  return (JSON.parse(out) as { result?: unknown }).result;
}

// The agents herdr lists, or null when herdr can't be reached.
export function agentList(session?: string): HerdrAgent[] | null {
  try {
    const result = run(['agent', 'list'], session) as { agents?: Record<string, unknown>[] };
    return (result.agents ?? []).map((agent) => ({
      name: typeof agent.name === 'string' && agent.name ? agent.name : null,
      agent: typeof agent.agent === 'string' ? agent.agent : null,
      pane: String(agent.pane_id),
      workspace: String(agent.workspace_id),
      status: typeof agent.agent_status === 'string' ? agent.agent_status : 'unknown',
      cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
    }));
  } catch {
    return null;
  }
}

// The pid of a pane's root process, or null. Always by `--pane`: herdr 0.7.1's `--current`
// answered for another pane than the caller's.
export function paneRootPid(pane: string, session?: string): number | null {
  try {
    const result = run(['pane', 'process-info', '--pane', pane], session) as { process_info?: { shell_pid?: unknown } };
    const pid = result.process_info?.shell_pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

// argv0 of each foreground process, in herdr's order, or null when the pane can't be
// read. `name` is not the process: a Claude entry's name is its version. After a CLI
// exits, herdr keeps the pane and the foreground process is the shell.
export function foregroundArgv0(result: unknown): string[] | null {
  const list = (result as { process_info?: { foreground_processes?: { argv0?: unknown }[] } } | null)
    ?.process_info?.foreground_processes;
  if (!Array.isArray(list)) return null;
  return list.map((proc) => (typeof proc?.argv0 === 'string' ? proc.argv0 : ''));
}

export function paneForeground(pane: string, session?: string): string[] | null {
  try {
    return foregroundArgv0(run(['pane', 'process-info', '--pane', pane], session));
  } catch {
    return null;
  }
}

// Whether a pane's foreground program is back to the shell, from a `pane process-info` result:
// true when a foreground process is the pane's own shell process, false when none is, and null
// when herdr can't say — no process info, no `shell_pid` (an older herdr), an empty or
// unreadable list. Never read from argv0 alone: a `zsh script.sh` child shares the pane shell's
// argv0 and is not the shell. Captured from herdr 0.7.1: a pane at its shell reports one
// foreground process whose pid is `shell_pid`; a pane running a program reports the program's
// pid, not the shell's.
export function shellBackOf(result: unknown): boolean | null {
  const info = (result as { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown }[] } } | null)
    ?.process_info;
  if (!info || typeof info.shell_pid !== 'number') return null;
  const list = info.foreground_processes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const pids = list.map((proc) => (typeof proc?.pid === 'number' ? proc.pid : null));
  if (pids.some((pid) => pid === null)) return null;
  return pids.includes(info.shell_pid);
}

export function paneShellBack(pane: string, session?: string): boolean | null {
  try {
    return shellBackOf(run(['pane', 'process-info', '--pane', pane], session));
  } catch {
    return null;
  }
}

export type HerdrWorkspace = { id: string; label: string };

export function workspaceList(session?: string): HerdrWorkspace[] | null {
  try {
    const result = run(['workspace', 'list'], session) as { workspaces?: Record<string, unknown>[] };
    return (result.workspaces ?? []).map((workspace) => ({
      id: String(workspace.workspace_id),
      label: typeof workspace.label === 'string' ? workspace.label : '',
    }));
  } catch {
    return null;
  }
}

export type SessionState = 'running' | 'stopped' | 'absent';

// Whether a session exists and runs. A stopped session stays listed with running false; a deleted
// one is absent. Null when herdr can't be reached. "default" is herdr's own.
export function sessionState(name: string): SessionState | null {
  try {
    const out = execFileSync('herdr', ['session', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const sessions = (JSON.parse(out) as { sessions?: { name?: string; running?: boolean }[] }).sessions ?? [];
    const found = sessions.find((session) => session.name === name);
    if (!found) return 'absent';
    return found.running === true ? 'running' : 'stopped';
  } catch {
    return null;
  }
}

// Whether a session exists and runs: null when herdr can't be reached.
export function sessionRunning(name: string): boolean | null {
  const state = sessionState(name);
  return state === null ? null : state === 'running';
}

// What a herdr command printed, or null when it did not run. Exit status is not the answer: a
// command aimed at a session that does not exist can print an error and exit 0.
function capture(args: string[], session?: string): string | null {
  const full = [...(session ? ['--session', session] : []), ...args];
  try {
    return execFileSync('herdr', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  } catch {
    return null;
  }
}

function parsed(out: string): { type?: string; result?: unknown } | null {
  try {
    return JSON.parse(out) as { type?: string; result?: unknown };
  } catch {
    return null;
  }
}

function resultOf(args: string[], session?: string): unknown | null {
  const out = capture(args, session);
  if (out === null) return null;
  const body = parsed(out);
  if (!body || body.type === 'error') return null;
  return body.result ?? null;
}

const SERVER_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG'] as const;

// Starts a session's server in a clean environment. Refuses unless the session is absent: a
// second server for a session that already runs has been seen to drop it.
export function startServer(session: string): boolean {
  if (sessionState(session) !== 'absent') return false;
  const env: NodeJS.ProcessEnv = {};
  for (const name of SERVER_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const args = session === 'default' ? ['server'] : ['--session', session, 'server'];
  try {
    const child = spawn('herdr', args, { env, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function workspaceCreate(
  cwd: string,
  label: string,
  session?: string,
): { pane: string; workspace: string } | null {
  const result = resultOf(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'], session) as {
    root_pane?: { pane_id?: unknown };
    workspace?: { workspace_id?: unknown };
  } | null;
  const pane = result?.root_pane?.pane_id;
  const workspace = result?.workspace?.workspace_id;
  if (typeof pane !== 'string' || typeof workspace !== 'string') return null;
  return { pane, workspace };
}

// Types a command into a pane and sends it. For a seat's launch, at a shell. An exit into an
// agent is `typeText` and then `pressEnter`, and only after the screen was read as idle again.
export function paneRun(pane: string, command: string, session?: string): boolean {
  const out = capture(['pane', 'run', pane, command], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || body.type !== 'error';
}

// Not proof an agent is there: herdr answers with agent_info for a pane that has none.
export function agentRename(pane: string, name: string, session?: string): boolean {
  const out = capture(['agent', 'rename', pane, name], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || body.type !== 'error';
}

export function workspaceClose(workspace: string, session?: string): boolean {
  const out = capture(['workspace', 'close', workspace], session);
  if (out === null) return false;
  const body = parsed(out);
  return body !== null && body.type !== 'error';
}

// Stops a session, which herdr keeps listed as stopped.
export function sessionStop(name: string): boolean {
  const out = capture(['session', 'stop', name]);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || body.type !== 'error';
}

// Clears a stopped session — the one case `team` deletes: `down`, on the session it has itself
// just stopped in the same run, so the next `up` starts from the beginning. `up` never deletes:
// its refusal names this command and leaves it to the owner.
export function sessionDelete(name: string): boolean {
  const out = capture(['session', 'delete', name]);
  if (out === null) return false;
  const body = parsed(out);
  return body !== null && body.type !== 'error';
}

// The process call behind paneRead, injectable for tests: it returns the call's stdout and
// throws when herdr refuses an option or the call times out. The real one shells out.
export type PaneExec = (args: string[]) => string;
const shellPaneExec: PaneExec = (args) =>
  execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
let paneExec: PaneExec = shellPaneExec;

/** Swaps the process call paneRead makes; null restores the real one. */
export function setPaneExec(exec: PaneExec | null): void {
  paneExec = exec ?? shellPaneExec;
}

// The visible-line window `status` and the watch both read: one value, so a report and the watch
// can't classify different windows of the same pane.
export const PANE_WINDOW = 14;

// The visible lines of a pane, or null. `session` undefined reaches the caller's own server.
// The lines keep their ANSI styling, CRLF folded to LF: a greyed suggestion and typed text
// read the same as plain text, and only their styling tells them apart, so the readers that
// want plain text strip it (`stripSgr`). An herdr without the `--format` option refuses the
// styled call and is read by the exact call main makes today — no flag at all — where
// unstyled text can never read as dim and the placeholder list alone decides. A herdr that
// hangs is not asked twice: one timeout reads null.
export function paneRead(pane: string, lines: number, session?: string): string | null {
  const full = [...(session ? ['--session', session] : []), 'pane', 'read', pane, '--source', 'visible', '--lines', String(lines)];
  let styled: string;
  try {
    styled = paneExec([...full, '--format', 'ansi']);
  } catch (error) {
    if (!(error instanceof Error)) return null;
    // execFileSync reports its own timeout as an Error with code ETIMEDOUT — signal SIGTERM,
    // status null, and no killed field. Observed under Bun, from a run, not from memory.
    if ((error as { code?: unknown }).code === 'ETIMEDOUT') return null;
    try {
      return paneExec(full);
    } catch {
      return null;
    }
  }
  return styled.replace(/\r\n/g, '\n').replace(/\r$/, '');
}

// The words to type for a herdr command, for a repair line.
export function herdrCommand(session: string | undefined, ...args: string[]): string {
  return ['herdr', ...(session && session !== 'default' ? ['--session', session] : []), ...args].join(' ');
}

// The two functions that type. Their callers have just seen the pane at an empty idle prompt,
// look at it again between the text and the Enter, and type nothing anywhere else.
export function typeText(pane: string, text: string, session?: string): boolean {
  try {
    execFileSync('herdr', [...(session ? ['--session', session] : []), 'pane', 'send-text', pane, text], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function pressEnter(pane: string, session?: string): boolean {
  return sendKey(pane, 'enter', session);
}

/** One key, by the name `herdr pane send-keys` takes. The same call `pressEnter` uses. */
export function sendKey(pane: string, key: string, session?: string): boolean {
  try {
    execFileSync('herdr', [...(session ? ['--session', session] : []), 'pane', 'send-keys', pane, key], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// The status herdr reports for one pane's agent, or null.
export function agentStatus(pane: string, session?: string): string | null {
  return agentList(session)?.find((agent) => agent.pane === pane)?.status ?? null;
}

// The herdr versions this version of `team` was run with.
export const HERDR_TESTED = { from: '0.7.1', to: '0.7.1' };

// What `herdr --version` prints, without the name, or null when herdr can't be run.
export function herdrVersion(): string | null {
  try {
    const out = execFileSync('herdr', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return out.trim().replace(/^herdr\s+/, '') || null;
  } catch {
    return null;
  }
}
