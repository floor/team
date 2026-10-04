import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { approvalDifferencesOf, notInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner, mayChangeTeam } from '../caller.ts';
import { insideTrust } from '../file/paths.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { emptySession, readState, withLock, writeAtomic, STATE_FILE, type State } from '../state.ts';
import { approvalStanding } from '../store/store.ts';
import { fillPattern, publicNameHit, realLanding, taskProblem } from '../worktree/place.ts';

// What the command reads from outside the process, so a test can point the approval store elsewhere.
export type WorktreeSources = {
  home: string;
  now(): Date;
};

export const realSources: WorktreeSources = {
  home: homedir(),
  now: () => new Date(),
};

type Run = { code: number; stdout: string; stderr: string };

export const USAGE = `Usage: team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>]
       team worktree remove <task> [--session <name>] [--file <path>]
Ignored files in the worktree are deleted with it.
`;

export const worktree: Command = (argv, io) => runWorktree(argv, io, realSources);
export default worktree;

export async function runWorktree(argv: string[], io: Io, sources: WorktreeSources = realSources): Promise<number> {
  const args = readArgs(argv, ['kind', 'seat', 'session', 'file'], []);
  const sub = args.rest[0];
  const task = args.rest[1];
  if (args.error) {
    io.stderr(`team worktree: ${args.error}\n${USAGE}`);
    return 2;
  }
  if (sub !== 'new' && sub !== 'remove') {
    io.stderr(`team worktree: ${sub ? `unknown subcommand "${sub}"` : 'a subcommand is required'}\n${USAGE}`);
    return 2;
  }
  if (!task) {
    io.stderr(`team worktree: a task name is required\n${USAGE}`);
    return 2;
  }
  if (args.rest.length > 2) {
    io.stderr(`team worktree: unexpected "${args.rest[2]}"\n${USAGE}`);
    return 2;
  }
  if (sub === 'remove' && (args.values.kind || args.values.seat)) {
    io.stderr(`team worktree: remove takes no --kind or --seat\n${USAGE}`);
    return 2;
  }

  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team worktree: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  const { team, root } = loaded;
  const caller = callerOf(io);
  if (args.values.file && !isOwner(caller)) {
    io.stderr(`team worktree: --file is the owner's, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`);
    return 1;
  }
  if (!mayChangeTeam(caller, team)) {
    io.stderr(`team worktree: only the owner, the coordinator or the operator runs it; this call is ${describeCaller(caller)}\n`);
    return 1;
  }
  const session = args.values.session ?? team.session;
  if (session === 'default') {
    io.stderr('team worktree: session can\'t be "default", herdr\'s own session\n');
    return 1;
  }
  const standing = approvalStanding(root, sources.home);
  if (standing.kind !== 'verified') {
    io.stderr(`team worktree: ${notInForce(standing)}\n`);
    return 1;
  }
  const differences = approvalDifferencesOf(standing, team);
  if (differences.length) {
    io.stderr(`team worktree: the file is not the approved one (${differences.join('; ')}): run \`team approve\`\n`);
    return 1;
  }

  const dir = dirname(loaded.path);
  const who = describeCaller(caller);
  if (sub === 'new') return create(io, sources, team, root, dir, session, task, args.values.kind, args.values.seat, who);
  return removeWorktree(io, sources, team, root, dir, session, task, who);
}

function create(
  io: Io, sources: WorktreeSources, team: TeamFile, root: string, dir: string, session: string, task: string,
  kind: string | undefined, seatName: string | undefined, who: string,
): number {
  const named = taskProblem(task);
  if (named) {
    io.stderr(`team worktree: ${named}\n`);
    return 1;
  }
  if (kind !== undefined && taskProblem(kind)) {
    io.stderr(`team worktree: --kind: ${taskProblem(kind)}\n`);
    return 1;
  }
  if (team.workspace.mode === 'shared') {
    io.stderr('team worktree: workspace.mode is shared: this team keeps one checkout, so there is no task worktree to create\n');
    return 1;
  }
  const pathPattern = team.workspace.path;
  const base = team.workspace.base;
  if (!pathPattern || !base) {
    io.stderr('team worktree: workspace.path and workspace.base are required\n');
    return 1;
  }
  if (pathPattern.includes('{kind}')) {
    io.stderr('team worktree: workspace.path fills {repo} and {task} only\n');
    return 1;
  }
  const branchPattern = team.workspace.branch;
  if (branchPattern.includes('{kind}') && kind === undefined) {
    io.stderr(`team worktree: --kind is required: the branch pattern is ${JSON.stringify(branchPattern)}\n`);
    return 1;
  }
  if (!branchPattern.includes('{kind}') && kind !== undefined) {
    io.stderr(`team worktree: --kind has nowhere to go: the branch pattern is ${JSON.stringify(branchPattern)}\n`);
    return 1;
  }
  const branch = fillPattern(branchPattern, { kind, task });
  const folder = fillPattern(pathPattern, { repo: team.project, task });
  if (!branch || !folder) {
    io.stderr('team worktree: the branch or path pattern has a placeholder other than {kind}, {task} or {repo}\n');
    return 1;
  }
  const hit = publicNameHit(team, [task, kind, branch, basename(folder)].filter((name): name is string => Boolean(name)));
  if (hit) {
    io.stderr(`team worktree: ${hit}; a public project refuses that name\n`);
    return 1;
  }
  if (!insideTrust(folder, team.trust)) {
    io.stderr(`team worktree: ${folder} is outside the approved trust paths\n`);
    return 1;
  }
  const landing = realLanding(root, folder);
  if (landing.real !== landing.logical) {
    const rel = relative(realpathSync(root), landing.real).split(sep).join('/');
    if (!insideTrust(rel, team.trust)) {
      io.stderr(`team worktree: ${folder} follows a symlink to ${landing.real}, which is outside the approved trust paths\n`);
      return 1;
    }
  }
  if (seatName !== undefined && !team.seats.some((seat) => seat.name === seatName)) {
    io.stderr(`team worktree: --seat ${JSON.stringify(seatName)} names no declared seat\n`);
    return 1;
  }

  const absolute = landing.logical;
  let refused: string | null = null;
  const outcome = withLock(dir, () => {
    const state = readState(dir);
    refused = openRefusal(state, team.workspace.limit, task, session);
    if (refused) return null;
    if (existsSync(absolute)) {
      refused = `${folder} already exists`;
      return null;
    }
    const branchTaken = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (branchTaken.code === 0) {
      refused = `branch ${branch} already exists`;
      return null;
    }
    const published = publishedBranch(root, branch);
    if (published) {
      refused = `${published} already exists`;
      return null;
    }
    const format = git(root, ['check-ref-format', '--branch', branch]);
    if (format.code !== 0) {
      refused = `${JSON.stringify(branch)} is not a branch name`;
      return null;
    }
    const start = startPoint(root, base);
    if ('error' in start) {
      refused = start.error;
      return null;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    const added = git(root, ['worktree', 'add', '-q', '-b', branch, absolute, start.ref]);
    if (added.code !== 0) {
      refused = `the worktree was not created: ${firstLine(added.stderr || added.stdout)}`;
      return null;
    }
    const setup = runSetup(absolute, team.workspace.setup);
    const record = {
      path: folder,
      branch,
      own_commits: false,
      ...(seatName ? { seat: seatName } : {}),
      setup: setup.ok ? 'ok' as const : 'failed' as const,
    };
    const sessionState = state.sessions[session] ?? emptySession();
    state.sessions[session] = sessionState;
    sessionState.worktrees[task] = record;
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return { start, setup };
  });
  if (refused || !outcome) {
    io.stderr(`team worktree: ${refused ?? 'nothing was created'}\n`);
    return 1;
  }
  if (!outcome.setup.ok) {
    logLine(dir, 'worktree new', who, `created ${task} at ${folder} on ${branch}; setup failed on command ${outcome.setup.at}`, sources.now());
    io.stderr(`team worktree: setup failed on command ${outcome.setup.at} of ${team.workspace.setup.length}; the worktree is kept and recorded as setup: failed\n`);
    io.stdout(`${folder}\n`);
    return 1;
  }
  const note = outcome.start.note ? `; ${outcome.start.note}` : '';
  logLine(dir, 'worktree new', who, `created ${task} at ${folder} on ${branch}${note}`, sources.now());
  io.stdout(`${folder}\n`);
  return 0;
}

export function removeWorktree(
  io: Io, sources: WorktreeSources, team: TeamFile, root: string, dir: string, session: string, task: string, who: string,
): number {
  const named = taskProblem(task);
  if (named) {
    io.stderr(`team worktree: ${named}\n`);
    return 1;
  }
  let refused: string | null = null;
  const removed = withLock(dir, () => {
    const state = readState(dir);
    const found = findWorktree(state, task, session);
    if (!found) {
      refused = `no worktree named ${JSON.stringify(task)} is recorded`;
      return false;
    }
    if (!found.record) {
      refused = `${JSON.stringify(task)} is recorded in session ${found.elsewhere.join(', ')}, not in ${session}; nothing was removed`;
      return false;
    }
    const occupant = seatInTask(state, task);
    if (occupant) {
      refused = `seat ${occupant} is recorded in this worktree; team remove ${occupant} first`;
      return false;
    }
    const record = found.record;
    const absolute = resolve(root, record.path);
    if (!existsSync(absolute)) {
      git(root, ['worktree', 'prune']);
      delete found.session.worktrees[task];
      writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
      return 'gone' as const;
    }
    const porcelain = git(absolute, ['status', '--porcelain']);
    if (porcelain.code !== 0) {
      refused = `couldn't read the worktree: ${firstLine(porcelain.stderr)}`;
      return false;
    }
    const dirty = porcelain.stdout.split('\n').filter((line) => line !== '');
    if (dirty.length) {
      refused = `uncommitted or untracked files:\n${list(dirty)}`;
      return false;
    }
    const unpublished = commitsOnNoRemote(root, absolute, record.branch, team.workspace.base);
    if (unpublished.length) {
      refused = `commits on no remote branch:\n${list(unpublished)}`;
      return false;
    }
    const gone = git(root, ['worktree', 'remove', absolute]);
    if (gone.code !== 0) {
      refused = `the worktree was not removed: ${firstLine(gone.stderr || gone.stdout)}`;
      return false;
    }
    delete found.session.worktrees[task];
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return record.branch;
  });
  if (refused || removed === false) {
    io.stderr(`team worktree: ${refused ?? 'nothing was removed'}\n`);
    return 1;
  }
  if (removed === 'gone') {
    logLine(dir, 'worktree remove', who, `removed the record of ${task}; its folder was already gone`, sources.now());
    io.stdout(`removed the record of ${task}; its folder was already gone. No branch was deleted.\n`);
    return 0;
  }
  logLine(dir, 'worktree remove', who, `removed ${task}; kept branch ${removed}`, sources.now());
  io.stdout(`removed ${task}; the branch ${removed} is kept\n`);
  return 0;
}

function openRefusal(state: State, limit: number, task: string, session: string): string | null {
  let open = 0;
  for (const [name, recorded] of Object.entries(state.sessions)) {
    open += Object.keys(recorded.worktrees).length;
    if (recorded.worktrees[task]) {
      return name === session
        ? `${JSON.stringify(task)} is already recorded`
        : `${JSON.stringify(task)} is already recorded in session ${name}`;
    }
  }
  if (open >= limit) return `the worktree limit is ${limit}, and ${open} are open`;
  return null;
}

// The record in the session this call is for. A record that lives only in another session is
// reported, not removed: `--session` chooses, and one call never clears two.
function findWorktree(state: State, task: string, sessionName: string) {
  const recorded = state.sessions[sessionName];
  const record = recorded?.worktrees[task];
  if (record && recorded) return { elsewhere: [] as string[], session: recorded, record };
  const elsewhere = Object.entries(state.sessions)
    .filter(([name, session]) => name !== sessionName && session.worktrees[task])
    .map(([name]) => name);
  if (elsewhere.length) return { elsewhere, session: recorded ?? emptySession(), record: undefined };
  return null;
}

function seatInTask(state: State, task: string): string | null {
  for (const recorded of Object.values(state.sessions)) {
    for (const [name, seat] of Object.entries(recorded.seats)) {
      if (seat.temporary?.task === task) return name;
    }
  }
  return null;
}

// The commit the new branch starts from: the base's upstream after a fetch, or the local base
// when the base has no upstream. A failed fetch creates nothing.
function startPoint(root: string, base: string): { ref: string; note?: string } | { error: string } {
  const local = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
  if (local.code !== 0) return { error: `workspace.base ${JSON.stringify(base)} is not a branch here; nothing was created` };
  const upstream = git(root, ['rev-parse', '--abbrev-ref', `${base}@{upstream}`]);
  if (upstream.code !== 0) {
    return { ref: base, note: `base ${base} has no upstream, so the worktree starts from the local branch` };
  }
  const remote = upstream.stdout.trim();
  const slash = remote.indexOf('/');
  if (slash <= 0) return { error: `base ${base} tracks ${JSON.stringify(remote)}, which isn't a remote branch; nothing was created` };
  const fetched = git(root, ['fetch', '--quiet', remote.slice(0, slash), remote.slice(slash + 1)]);
  if (fetched.code !== 0) {
    return { error: `couldn't fetch ${remote}: ${firstLine(fetched.stderr || fetched.stdout) || 'fetch failed'}. Nothing was created.` };
  }
  return { ref: remote };
}

// The recorded branch and whatever HEAD the worktree has checked out. A detached HEAD, or
// another branch, is not the recorded branch; removing the folder drops that reflog, so a commit
// that lives only there is named and the folder stays. With no remote-tracking refs, unpublished
// means not in the base.
function commitsOnNoRemote(root: string, worktree: string, branch: string, base: string | null): string[] {
  const remotes = git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
  const args = remotes.stdout.trim()
    ? ['rev-list', '--oneline', 'HEAD', branch, '--not', '--remotes']
    : ['rev-list', '--oneline', 'HEAD', branch, '--not', base ?? 'HEAD'];
  const listed = git(worktree, args);
  if (listed.code !== 0) return [`couldn't list commits: ${firstLine(listed.stderr)}`];
  return listed.stdout.split('\n').filter((line) => line !== '');
}

function runSetup(cwd: string, commands: string[]): { ok: true } | { ok: false; at: number } {
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i] as string;
    const result = spawnSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if ((result.status ?? 1) !== 0) return { ok: false, at: i + 1 };
  }
  return { ok: true };
}

function publishedBranch(root: string, branch: string): string | null {
  const listed = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  for (const ref of listed.stdout.split('\n')) {
    const slash = ref.indexOf('/');
    if (slash > 0 && ref.slice(slash + 1) === branch) return ref;
  }
  return null;
}

function git(cwd: string, args: string[]): Run {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function list(lines: string[]): string {
  const shown = lines.slice(0, 20).map((line) => `  ${line}`);
  if (lines.length > 20) shown.push(`  and ${lines.length - 20} more`);
  return shown.join('\n');
}
