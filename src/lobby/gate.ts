import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The lobby path for a given user home: `<home>/.config/team/lobby`. */
export function lobbyDir(home: string = homedir()): string {
  return join(home, '.config', 'team', 'lobby');
}

/** Walks up ancestors looking for a `.git` entry (file or directory). */
export function findRepoRoot(startPath: string): string | null {
  let current = resolve(startPath);
  while (true) {
    const gitPath = join(current, '.git');
    try {
      const stat = lstatSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // not found
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export type LobbyGateResult =
  | { ok: true; missing?: boolean }
  | { ok: false; problem: 'symlink' | 'owner' | 'mode' | 'not-empty' | 'repo' | 'not-directory'; text: string; component?: string };

export interface VerifyLobbyOptions {
  create?: boolean;
  getuid?: () => number;
}

/**
 * Verifies the lobby folder and all components from `home` down to `lobby`.
 * If `create` is true, creates missing components one at a time without following symbolic links,
 * setting mode 0700 on the lobby.
 */
export function verifyLobby(home: string, options?: VerifyLobbyOptions): LobbyGateResult {
  const lobby = lobbyDir(home);
  const myUid = options?.getuid ? options.getuid() : process.getuid?.() ?? 0;

  const chain = [
    home,
    join(home, '.config'),
    join(home, '.config', 'team'),
    lobby,
  ];

  // 1. Check existing components from home down
  for (const comp of chain) {
    if (existsSync(comp)) {
      let stat;
      try {
        stat = lstatSync(comp);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: ${comp} is a symbolic link`, component: comp };
      }
      if (stat.uid !== myUid) {
        return { ok: false, problem: 'owner', text: `the lobby ${lobby}: ${comp} is not owned by you`, component: comp };
      }
    }
  }

  // 2. If creating missing components
  if (options?.create) {
    for (let i = 1; i < chain.length; i++) {
      const comp = chain[i] as string;
      const parent = dirname(comp);
      let parentStat;
      try {
        parentStat = lstatSync(parent);
      } catch {
        return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: ${parent} does not exist` };
      }
      if (parentStat.isSymbolicLink()) {
        return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: ${parent} is a symbolic link`, component: parent };
      }
      if (parentStat.uid !== myUid) {
        return { ok: false, problem: 'owner', text: `the lobby ${lobby}: ${parent} is not owned by you`, component: parent };
      }

      if (!existsSync(comp)) {
        if (comp === lobby) {
          mkdirSync(comp, { mode: 0o700 });
          chmodSync(comp, 0o700);
        } else {
          mkdirSync(comp);
        }
      }

      let stat;
      try {
        stat = lstatSync(comp);
      } catch {
        return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: ${comp} does not exist` };
      }
      if (stat.isSymbolicLink()) {
        return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: ${comp} is a symbolic link`, component: comp };
      }
      if (stat.uid !== myUid) {
        return { ok: false, problem: 'owner', text: `the lobby ${lobby}: ${comp} is not owned by you`, component: comp };
      }
    }
  }

  // 3. If lobby does not exist
  if (!existsSync(lobby)) {
    if (!options?.create) {
      return { ok: true, missing: true };
    }
    return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: is not a directory` };
  }

  // 4. Lobby must be a directory
  let lobbyStat;
  try {
    lobbyStat = lstatSync(lobby);
  } catch {
    return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: is not a directory` };
  }
  if (!lobbyStat.isDirectory()) {
    return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: is not a directory` };
  }

  // 5. Lobby mode must be exactly 0700
  const mode = lobbyStat.mode & 0o777;
  if (mode !== 0o700) {
    return { ok: false, problem: 'mode', text: `the lobby ${lobby}: has mode 0${mode.toString(8)}, not 0700` };
  }

  // 6. Lobby must be empty
  let entries: string[];
  try {
    entries = readdirSync(lobby);
  } catch {
    entries = [];
  }
  if (entries.length > 0) {
    return { ok: false, problem: 'not-empty', text: `the lobby ${lobby}: is not empty` };
  }

  // 7. Neither logical path nor canonical landing is inside a repository
  const logicalRepo = findRepoRoot(lobby);
  if (logicalRepo) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: is inside the repository ${logicalRepo}` };
  }

  let canonicalLobby: string;
  try {
    canonicalLobby = realpathSync(lobby);
  } catch {
    canonicalLobby = lobby;
  }
  const canonicalRepo = findRepoRoot(canonicalLobby);
  if (canonicalRepo) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: is inside the repository ${canonicalRepo}` };
  }

  return { ok: true };
}
