import { execFileSync } from 'node:child_process';

// The only module that talks to herdr. Everything here reads, except `typeLine`.

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

// Whether a session exists and runs: null when herdr can't be reached. "default" is herdr's own.
export function sessionRunning(name: string): boolean | null {
  try {
    const out = execFileSync('herdr', ['session', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    const sessions = (JSON.parse(out) as { sessions?: { name?: string; running?: boolean }[] }).sessions ?? [];
    return sessions.some((session) => session.name === name && session.running === true);
  } catch {
    return null;
  }
}

// The visible lines of a pane, or null. `session` undefined reaches the caller's own server.
export function paneRead(pane: string, lines: number, session?: string): string | null {
  try {
    const full = [...(session ? ['--session', session] : []), 'pane', 'read', pane, '--source', 'visible', '--lines', String(lines)];
    return execFileSync('herdr', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return null;
  }
}

// The words to type for a herdr command, for a repair line.
export function herdrCommand(session: string | undefined, ...args: string[]): string {
  return ['herdr', ...(session && session !== 'default' ? ['--session', session] : []), ...args].join(' ');
}

// Types one line into a pane and sends it. The one function that types: its callers have just
// seen the pane at an empty idle prompt, and type nothing anywhere else.
export function typeLine(pane: string, text: string, session?: string): boolean {
  const prefix = session ? ['--session', session] : [];
  try {
    execFileSync('herdr', [...prefix, 'pane', 'send-text', pane, text], { stdio: 'ignore', timeout: 10_000 });
    execFileSync('herdr', [...prefix, 'pane', 'send-keys', pane, 'enter'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
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
