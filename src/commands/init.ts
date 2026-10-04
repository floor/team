import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { TEAM_FILE, findRoot } from '../file/load.ts';
import { validateTeamFile } from '../file/validate.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { LOCK_FILE, LOG_FILE, STATE_FILE, writeAtomic } from '../state.ts';
import { approvedCopy } from '../store/store.ts';
import { version } from '../version.ts';

// What git must never pick up: the file and the runtime files beside it.
export const EXCLUDED = [TEAM_FILE, `.agents/${STATE_FILE}`, `.agents/${LOG_FILE}*`, `.agents/${LOCK_FILE}`];

export const PRIVACY = `The team file is private to this clone: it is listed in .git/info/exclude, never in .gitignore,
so git doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or
receives one and approves it themselves.`;

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function skeleton(project: string, head: string | null, teamVersion = version()): string {
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/floor/team/v${teamVersion}/schema/team.schema.json
# The team of ${project}. Private to this clone: see .git/info/exclude.
# Nothing here runs until the owner has read it and run \`team approve\`.
format: 1
project: ${project}
# visibility: public          # public | private: whether forbidden_public applies
# session: ${project}          # the herdr session; never "default"
coordinator: coordinator      # the seat that dispatches work
operator: coordinator         # the seat the watch reports to

# identity:
#   signature:
#     template: "Agent: {display} · {role}"
#     commits:
#       position: trailer     # last-line | trailer | anywhere
#       exempt: [merge]
#     pull_requests:
#       position: last-line
#       template: "**Agent:** {display} · {role}"
#   humans: []                # commit authors who don't sign
${head ? `#   since: ${head}   # check reads no commit reachable from this one\n` : ''}#   forbidden: []            # added to the defaults
#   forbidden_public: []

# rules:                      # added to every seat's rules at launch
#   - Run the tests your change touches.

# trust:                      # applied only by the owner, with \`team trust\`
#   - .
#   - ../worktrees/${project}/*

workspace:
  mode: shared                # worktree | shared
  # path: ../worktrees/{repo}/{task}
  # base: main

seats:
  - role: coordinator
    name: coordinator
    cli: claude-code          # claude-code | codex | cursor | grok | antigravity
    vendor: anthropic
    model: Claude Opus        # the model's name without its version
    version: "0"              # the release number alone, quoted
    launch: claude            # the command and its model options; no approval flags
`;
}

// Adds the lines git must exclude, once each, to the common directory's info/exclude.
export function exclude(root: string): string[] {
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common) throw new Error('git doesn\'t answer for this folder');
  const path = join(common, 'info', 'exclude');
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = EXCLUDED.filter((line) => !present.has(line));
  if (missing.length) {
    writeAtomic(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
  return missing;
}

export const init: Command = (argv, io) => runInit(argv, io);
export default init;

export const USAGE = 'Usage: team init [--restore]\n';

// `home` is where the user-level store is looked for; tests hand in a temporary one.
export async function runInit(argv: string[], io: Io, home?: string): Promise<number> {
  const args = readArgs(argv, [], ['restore']);
  if (args.error || args.rest.length) {
    io.stderr(`team init: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2;
  }
  const caller = callerOf(io);
  if (!isOwner(caller)) {
    io.stderr(`team init: only the owner runs init, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`);
    return 1;
  }
  const root = findRoot(io.cwd);
  if (!root) {
    io.stderr('team init: not inside a git repository\n');
    return 2;
  }
  const path = join(root, TEAM_FILE);
  if (git(root, 'ls-files', '--error-unmatch', TEAM_FILE) !== null) {
    io.stderr(`team init: ${TEAM_FILE} is tracked by git, and a team file is private. Untrack it, keeping the file:\n  git rm --cached ${TEAM_FILE}\nthen run team init again. History is not rewritten.\n`);
    return 1;
  }
  if (existsSync(path)) {
    exclude(root);
    io.stderr(`team init: ${TEAM_FILE} exists already; it is left as it is. Its lines in .git/info/exclude were checked, and added where missing.\n`);
    return 1;
  }

  let text: string;
  if (args.flags.has('restore')) {
    const copy = home === undefined ? approvedCopy(root) : approvedCopy(root, home);
    if (copy === null) {
      io.stderr('team init: nothing to restore: no team file was approved for this folder on this machine. Run team init for a skeleton.\n');
      return 1;
    }
    text = copy;
  } else {
    text = skeleton(basename(root), git(root, 'rev-parse', 'HEAD'));
    const check = validateTeamFile(text);
    if (!check.ok) throw new Error(`the skeleton doesn't validate: ${check.errors[0]?.message}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const added = exclude(root);
  writeFileSync(path, text, { flag: 'wx' });
  const what = args.flags.has('restore') ? 'restored the approved copy' : 'wrote a skeleton';
  logLine(dirname(path), 'init', describeCaller(caller), `${what} as ${TEAM_FILE}; excluded ${added.length} path(s)`);
  io.stdout(args.flags.has('restore')
    ? `Restored ${TEAM_FILE} from the copy you last approved on this machine.\n\n${PRIVACY}\n`
    : `Wrote ${TEAM_FILE}: a skeleton with one seat. Edit it, then run team approve.\n\n${PRIVACY}\n`);
  return 0;
}
