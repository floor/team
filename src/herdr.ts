import { execFileSync } from 'node:child_process';

// The only module that talks to herdr. Everything here reads; nothing types into a pane.

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
