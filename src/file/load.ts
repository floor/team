import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fixedFolder } from './paths.ts';
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
export function loadTeamFile(cwd: string, options: { file?: string } = {}): LoadResult {
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
  const errors = placedProblems(result.team, root);
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
export function placedProblems(team: TeamFile, root: string): Problem[] {
  const project = real(root);
  const problems: Problem[] = [];
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
