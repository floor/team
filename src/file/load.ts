import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lobbyDir } from '../lobby/gate.ts';
import { canonicalLanding, fixedFolder, isLegacyTrust, isMigratedTrust } from './paths.ts';
import type { LoadResult, Problem, TeamFile } from './types.ts';
import { validateTeamFile } from './validate.ts';

export const TEAM_FILE = '.agents/team.yaml';

// The project's root: the main checkout, found through git's common directory, so a command run
// in a subfolder or in a linked worktree reads the same `.agents/`.
export function findRoot(cwd: string): string | null {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return common ? dirname(common) : null;
  } catch {
    return null;
  }
}

// Finds, reads and validates the team file. With `file`, the root is the folder that holds the
// file's `.agents/`, or the file's own folder when it sits elsewhere.
export function loadTeamFile(cwd: string, options: { file?: string; home?: string } = {}): LoadResult {
  let path: string;
  let root: string;
  if (options.file) {
    path = isAbsolute(options.file) ? options.file : resolve(cwd, options.file);
    const folder = dirname(path);
    root = folder.endsWith('.agents') ? dirname(folder) : folder;
  } else {
    const found = findRoot(cwd);
    if (!found) return { ok: false, errors: [{ line: 0, message: 'not inside a git repository: run team from a project, or pass --file' }] };
    root = found;
    path = join(root, TEAM_FILE);
  }
  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      errors: [{
        line: 0,
        message: options.file
          ? `no team file at ${options.file}`
          : 'no team file here; it is private to each clone: run `team init`, or `team init --restore` to bring back the copy you last approved on this machine',
      }],
    };
  }
  // One read. Callers that store the text (approve) use this string, the one that was validated.
  const text = readFileSync(path, 'utf8');
  const result = validateTeamFile(text);
  if (!result.ok) return { ...result, path };
  const errors = placedProblems(result.team, root, options.home);
  return errors.length ? { ok: false, errors, path } : { ...result, root, path, text };
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// What only shows once the root is known: a folder named by its own name can still be the
// project's parent, as "../../Code/*" is for a project at ~/Code/acme. Validation on the text
// alone can't see that; here every fixed folder is resolved, symlinks included.
export function placedProblems(team: TeamFile, root: string, home: string = homedir()): Problem[] {
  const problems: Problem[] = [];

  if (isLegacyTrust(team.trust)) {
    const project = real(root);
    const holdsProject = (folder: string) => {
      const full = real(resolve(project, folder));
      return full !== project && project.startsWith(full.endsWith(sep) ? full : full + sep);
    };
    for (const pattern of team.trust) {
      if (holdsProject(fixedFolder(pattern))) {
        problems.push({ line: 0, message: `trust: "${pattern}" names the project's parent or a folder above it: it would trust every folder beside the project` });
      }
    }
    const path = team.workspace.path;
    if (path) {
      const folder = path.split('/').slice(0, -1).join('/').replaceAll('{repo}', team.project) || '.';
      if (holdsProject(folder)) {
        problems.push({ line: 0, message: `workspace.path: "${path}" puts worktrees in the project's parent or a folder above it: give them a folder of their own` });
      }
    }
    return problems;
  }

  if (isMigratedTrust(team.trust)) {
    const lobby = lobbyDir(home);
    const lobbyLanding = canonicalLanding(lobby).landing;

    // Check symlinks in trust entries (the lobby chain is checked by the gate)
    for (const entry of team.trust) {
      const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
      if (expanded === lobby || lobby.startsWith(expanded + sep)) {
        continue;
      }
      const res = canonicalLanding(expanded);
      if (res.symlink) {
        problems.push({ line: 0, message: `trust: "${entry}": ${res.symlink} is a symbolic link` });
      }
    }

    const hasLobby = team.trust.some((entry) => {
      const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
      return canonicalLanding(expanded).landing === lobbyLanding;
    });
    if (!hasLobby) {
      problems.push({ line: 0, message: `trust: must list the lobby ${lobby}` });
    }

    // Every seat's cwd must equal an approved entry or be a descendant of one
    for (const seat of team.seats) {
      const seatPath = resolve(root, seat.cwd);
      const seatLanding = canonicalLanding(seatPath).landing;
      const trusted = team.trust.some((entry) => {
        const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
        const entryLanding = canonicalLanding(expanded).landing;
        return seatLanding === entryLanding || seatLanding.startsWith(entryLanding.endsWith(sep) ? entryLanding : entryLanding + sep);
      });
      if (!trusted) {
        problems.push({ line: seat.line, message: `seat ${seat.name}: cwd "${seat.cwd}" is outside trust` });
      }
    }

    // Workspace landing (workspace.path for any task)
    if (team.workspace.path) {
      const sample = team.workspace.path.replaceAll('{repo}', team.project).replace('{task}', 'task');
      const wtPath = resolve(root, sample);
      const wtLanding = canonicalLanding(wtPath).landing;
      const trusted = team.trust.some((entry) => {
        const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
        const entryLanding = canonicalLanding(expanded).landing;
        return wtLanding === entryLanding || wtLanding.startsWith(entryLanding.endsWith(sep) ? entryLanding : entryLanding + sep);
      });
      if (!trusted) {
        problems.push({ line: 0, message: `workspace.path: "${team.workspace.path}" is outside trust` });
      }
    }
  }

  return problems;
}
