import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The lobby path for a given user home: `<home>/.config/team/lobby`. */
export function lobbyDir(home: string = homedir()): string {
  return join(home, '.config', 'team', 'lobby');
}

export interface FsStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  mode: number;
  uid: number;
}

export interface FsReader {
  lstat(path: string): FsStats;
  mkdir(path: string, options?: { mode?: number }): void;
  readdir(path: string): string[];
  realpath(path: string): string;
  chmod(path: string, mode: number): void;
}

export const defaultFs: FsReader = {
  lstat: (p) => lstatSync(p),
  mkdir: (p, opts) => mkdirSync(p, { recursive: false, mode: opts?.mode }),
  readdir: (p) => readdirSync(p),
  realpath: (p) => realpathSync(p),
  chmod: (p, m) => chmodSync(p, m),
};

/** Walks up ancestors looking for a `.git` entry (file or directory). */
export function findRepoRoot(startPath: string, fs: FsReader = defaultFs): string | null {
  let current = resolve(startPath);
  while (true) {
    const gitPath = join(current, '.git');
    try {
      const stat = fs.lstat(gitPath);
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
  | { ok: false; problem: 'symlink' | 'owner' | 'mode' | 'not-empty' | 'repo' | 'not-directory' | string; text: string; component?: string };

export interface VerifyLobbyOptions {
  create?: boolean;
  getuid?: () => number;
  fs?: FsReader;
}

/**
 * Verifies the lobby folder and all components from `home` down to `lobby`.
 * If `create` is true, creates missing components one at a time without following symbolic links,
 * setting mode 0700 on the lobby.
 */
export function verifyLobby(home: string, options?: VerifyLobbyOptions): LobbyGateResult {
  const lobby = lobbyDir(home);
  const fs = options?.fs ?? defaultFs;
  const myUid = options?.getuid ? options.getuid() : process.getuid?.() ?? 0;

  const chain = [
    home,
    join(home, '.config'),
    join(home, '.config', 'team'),
    lobby,
  ];

  function checkComp(comp: string): { ok: true; stat: FsStats } | { ok: false; problem: string; text: string; component?: string } {
    let stat: FsStats;
    try {
      stat = fs.lstat(comp);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: ${comp} does not exist`, component: comp };
      }
      return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${comp}: ${err?.code ?? err?.message}`, component: comp };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: ${comp} is a symbolic link`, component: comp };
    }
    if (!stat.isDirectory()) {
      const text = comp === lobby ? `the lobby ${lobby}: is not a directory` : `the lobby ${lobby}: ${comp} is not a directory`;
      return { ok: false, problem: 'not-directory', text, component: comp };
    }
    if (stat.uid !== myUid) {
      return { ok: false, problem: 'owner', text: `the lobby ${lobby}: ${comp} is not owned by you`, component: comp };
    }
    return { ok: true, stat };
  }

  // 1. Check home component first
  const homeCheck = checkComp(home);
  if (!homeCheck.ok) return homeCheck;

  // 2. Creation or traversal
  if (options?.create) {
    for (let i = 1; i < chain.length; i++) {
      const comp = chain[i] as string;
      const parent = chain[i - 1] as string;
      const parentCheck = checkComp(parent);
      if (!parentCheck.ok) return parentCheck;

      try {
        fs.lstat(comp);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          try {
            if (comp === lobby) {
              fs.mkdir(comp, { mode: 0o700 });
              fs.chmod(comp, 0o700);
            } else {
              fs.mkdir(comp);
            }
          } catch (mkErr: any) {
            return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: failed to create ${comp}: ${mkErr?.code ?? mkErr?.message}`, component: comp };
          }
          const createdCheck = checkComp(comp);
          if (!createdCheck.ok) return createdCheck;
          continue;
        }
        return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${comp}: ${err?.code ?? err?.message}`, component: comp };
      }

      const existingCheck = checkComp(comp);
      if (!existingCheck.ok) return existingCheck;
    }
  } else {
    for (const comp of chain) {
      let stat: FsStats;
      try {
        stat = fs.lstat(comp);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          if (comp === lobby) return { ok: true, missing: true };
          return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: ${comp} does not exist`, component: comp };
        }
        return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${comp}: ${err?.code ?? err?.message}`, component: comp };
      }
      if (stat.isSymbolicLink()) {
        return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: ${comp} is a symbolic link`, component: comp };
      }
      if (!stat.isDirectory()) {
        const text = comp === lobby ? `the lobby ${lobby}: is not a directory` : `the lobby ${lobby}: ${comp} is not a directory`;
        return { ok: false, problem: 'not-directory', text, component: comp };
      }
      if (stat.uid !== myUid) {
        return { ok: false, problem: 'owner', text: `the lobby ${lobby}: ${comp} is not owned by you`, component: comp };
      }
    }
  }

  // 3. Post-existence re-verification: verify entire chain from top down
  for (const comp of chain) {
    const verified = checkComp(comp);
    if (!verified.ok) return verified;
  }

  // 4. Realpath of lobby must equal path built from verified components
  let real: string;
  try {
    real = fs.realpath(lobby);
  } catch (err: any) {
    return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: cannot resolve canonical path: ${err?.code ?? err?.message}` };
  }
  let expectedLobby: string;
  try {
    expectedLobby = join(fs.realpath(home), '.config', 'team', 'lobby');
  } catch {
    expectedLobby = lobby;
  }
  if (real !== expectedLobby) {
    return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: canonical path ${real} does not match ${expectedLobby}` };
  }

  // 5. Lobby mode must be exactly 0700 on all 12 permission bits
  const lobbyStat = fs.lstat(lobby);
  const mode = lobbyStat.mode & 0o7777;
  if (mode !== 0o700) {
    return { ok: false, problem: 'mode', text: `the lobby ${lobby}: has mode 0${mode.toString(8)}, not 0700` };
  }

  // 6. Lobby must be empty; read errors refuse
  let entries: string[];
  try {
    entries = fs.readdir(lobby);
  } catch (err: any) {
    return { ok: false, problem: 'not-empty', text: `the lobby ${lobby}: cannot read directory: ${err?.code ?? err?.message}` };
  }
  if (entries.length > 0) {
    return { ok: false, problem: 'not-empty', text: `the lobby ${lobby}: is not empty` };
  }

  // 7. Neither logical path nor canonical landing is inside a repository
  const logicalRepo = findRepoRoot(lobby, fs);
  if (logicalRepo) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: is inside the repository ${logicalRepo}` };
  }

  const canonicalRepo = findRepoRoot(real, fs);
  if (canonicalRepo) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: is inside the repository ${canonicalRepo}` };
  }

  return { ok: true };
}
