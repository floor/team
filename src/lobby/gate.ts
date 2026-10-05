import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
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
  dev: number;
  ino: number;
}

export interface FsReader {
  lstat(path: string): FsStats;
  mkdir(path: string, options?: { mode?: number }): void;
  readdir(path: string): string[];
  realpath(path: string): string;
}

export const defaultFs: FsReader = {
  lstat: (p) => lstatSync(p),
  mkdir: (p, opts) => mkdirSync(p, { recursive: false, mode: opts?.mode }),
  readdir: (p) => readdirSync(p),
  realpath: (p) => realpathSync(p),
};

function codeOf(err: unknown): string {
  const error = err as { code?: string; message?: string };
  return String(error?.code ?? error?.message ?? 'unknown');
}

export type RepoSearch = { root: string | null; error?: { path: string; code: string } };

/** Walks ancestors for a `.git` entry. A read error other than absence is returned, never treated as "no repository". */
export function searchRepo(startPath: string, fs: FsReader = defaultFs): RepoSearch {
  let current = resolve(startPath);
  while (true) {
    const gitPath = join(current, '.git');
    try {
      const stat = fs.lstat(gitPath);
      if (stat.isDirectory() || stat.isFile()) return { root: current };
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') return { root: null, error: { path: gitPath, code: codeOf(err) } };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: null };
}

/** The repository that holds `startPath`, or null when none does. A read error is null here; the gate uses `searchRepo`. */
export function findRepoRoot(startPath: string, fs: FsReader = defaultFs): string | null {
  return searchRepo(startPath, fs).root;
}

export type LobbyGateResult =
  | { ok: true; path: string; dev: number; ino: number }
  | { ok: true; missing: true }
  | { ok: false; problem: 'symlink' | 'owner' | 'mode' | 'not-empty' | 'repo' | 'not-directory' | string; text: string; component?: string };

export interface VerifyLobbyOptions {
  create?: boolean;
  getuid?: () => number;
  fs?: FsReader;
}

type CompCheck = { ok: true; stat: FsStats } | { ok: false; problem: string; text: string; component?: string };

/**
 * Verifies the lobby folder and every component from `home` down to it.
 * When `create` is set, missing components are made one at a time, without following a link,
 * and the lobby is created with mode `0700` in its own mkdir call — this runtime applies that
 * mode under umask 022 and 077 alike — and nothing chmods it afterwards: the mode is checked
 * below and a wrong one is refused, never repaired, so no link swapped in after creation can
 * steer a mode change at a folder the gate did not create. The successful result's `path` is
 * the canonical path rebuilt from the components just `lstat`ed: the same string `realpath` of
 * the lobby returned. A read-only check of a lobby that is simply absent — including when
 * `~/.config` or `team` is not there yet — is `{ missing: true }`, not a failure.
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

  function checkComp(comp: string): CompCheck {
    let stat: FsStats;
    try {
      stat = fs.lstat(comp);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') {
        return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: ${comp} does not exist`, component: comp };
      }
      return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${comp}: ${codeOf(err)}`, component: comp };
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

  const homeCheck = checkComp(home);
  if (!homeCheck.ok) return homeCheck;

  if (options?.create) {
    for (let i = 1; i < chain.length; i++) {
      const comp = chain[i] as string;
      const parent = chain[i - 1] as string;
      const parentCheck = checkComp(parent);
      if (!parentCheck.ok) return parentCheck;

      try {
        fs.lstat(comp);
      } catch (err) {
        if (codeOf(err) !== 'ENOENT') {
          return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${comp}: ${codeOf(err)}`, component: comp };
        }
        try {
          fs.mkdir(comp, comp === lobby ? { mode: 0o700 } : undefined);
        } catch (mkErr) {
          return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: failed to create ${comp}: ${codeOf(mkErr)}`, component: comp };
        }
      }

      const seen = checkComp(comp);
      if (!seen.ok) return seen;
    }
  } else {
    for (const comp of chain) {
      let stat: FsStats;
      try {
        stat = fs.lstat(comp);
      } catch (err) {
        if (codeOf(err) === 'ENOENT') {
          if (comp === home) return { ok: false, problem: 'not-directory', text: `the lobby ${lobby}: ${comp} does not exist`, component: comp };
          return { ok: true, missing: true };
        }
        return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${comp}: ${codeOf(err)}`, component: comp };
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

  for (const comp of chain) {
    const verified = checkComp(comp);
    if (!verified.ok) return verified;
  }

  let homeReal: string;
  try {
    homeReal = fs.realpath(home);
  } catch (err) {
    return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot resolve ${home}: ${codeOf(err)}` };
  }
  const expectedLobby = join(homeReal, '.config', 'team', 'lobby');

  let real: string;
  try {
    real = fs.realpath(lobby);
  } catch (err) {
    return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: cannot resolve canonical path: ${codeOf(err)}` };
  }
  if (real !== expectedLobby) {
    return { ok: false, problem: 'symlink', text: `the lobby ${lobby}: canonical path ${real} does not match ${expectedLobby}` };
  }

  let lobbyStat: FsStats;
  try {
    lobbyStat = fs.lstat(lobby);
  } catch (err) {
    return { ok: false, problem: 'read-error', text: `the lobby ${lobby}: cannot read ${lobby}: ${codeOf(err)}`, component: lobby };
  }
  const mode = lobbyStat.mode & 0o7777;
  if (mode !== 0o700) {
    return { ok: false, problem: 'mode', text: `the lobby ${lobby}: has mode 0${mode.toString(8)}, not 0700` };
  }

  let entries: string[];
  try {
    entries = fs.readdir(lobby);
  } catch (err) {
    return { ok: false, problem: 'not-empty', text: `the lobby ${lobby}: cannot read directory: ${codeOf(err)}` };
  }
  if (entries.length > 0) {
    return { ok: false, problem: 'not-empty', text: `the lobby ${lobby}: is not empty` };
  }

  const logicalRepo = searchRepo(lobby, fs);
  if (logicalRepo.error) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: cannot read ${logicalRepo.error.path}: ${logicalRepo.error.code}` };
  }
  if (logicalRepo.root) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: is inside the repository ${logicalRepo.root}` };
  }
  const canonicalRepo = searchRepo(real, fs);
  if (canonicalRepo.error) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: cannot read ${canonicalRepo.error.path}: ${canonicalRepo.error.code}` };
  }
  if (canonicalRepo.root) {
    return { ok: false, problem: 'repo', text: `the lobby ${lobby}: is inside the repository ${canonicalRepo.root}` };
  }

  return { ok: true, path: real, dev: lobbyStat.dev, ino: lobbyStat.ino };
}

/** The lobby the gate verified, so a later check can say it is still the same folder. */
export interface LobbySeen {
  path: string;
  dev: number;
  ino: number;
}

/**
 * The confirmation a starting folder gets directly before it is used: the gate's own checks
 * again, and that it is still the folder the gate read — the same canonical path, the same
 * device and inode. Null when it is; the refusal line when it is not — the gate's own text
 * where the check refuses, so the operator reads the same cause the gate would have given.
 * Used by `up` and `add` before each workspace they make in the lobby, with nothing between
 * this and the create.
 */
export function recheckLobby(home: string, seen: LobbySeen, options?: { getuid?: () => number; fs?: FsReader }): string | null {
  const again = verifyLobby(home, { create: false, getuid: options?.getuid, fs: options?.fs });
  if (!again.ok) return again.text;
  if (!('path' in again)) return `the lobby ${seen.path}: it is not there any more`;
  if (again.path !== seen.path || again.dev !== seen.dev || again.ino !== seen.ino) {
    return `the lobby ${seen.path}: it is not the folder the gate read`;
  }
  return null;
}
