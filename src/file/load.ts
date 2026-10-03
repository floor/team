import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { LoadResult } from './types.ts';
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
  const result = validateTeamFile(readFileSync(path, 'utf8'));
  return result.ok ? { ...result, root, path } : { ...result, path };
}
