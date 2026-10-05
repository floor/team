import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { defaultFs, lobbyDir, type FsReader, type FsStats } from '../lobby/gate.ts';

// Paths in a team file are relative to the project's root, with "/" between segments. These
// checks are on the text alone; symlinks are resolved when trust is applied.

const CONTROL_OR_BACKTICK = /[\x00-\x1f\x7f`]/;

export function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(segment);
  }
  return out.join('/') || '.';
}

export function insideProject(path: string): boolean {
  const normal = normalize(path);
  return normal !== '..' && !normal.startsWith('../');
}

/** Whether a trust entry is a legacy project-relative pattern. */
export function isLegacyTrustEntry(entry: string): boolean {
  return !entry.startsWith('/') && !entry.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(entry);
}

/** True when every entry in trust is a legacy project-relative pattern. */
export function isLegacyTrust(trust: readonly string[]): boolean {
  return trust.length > 0 && trust.every(isLegacyTrustEntry);
}

/** True when every entry in trust is an absolute path or starts with "~". */
export function isMigratedTrust(trust: readonly string[]): boolean {
  return trust.length > 0 && trust.every((entry) => !isLegacyTrustEntry(entry));
}

// Why a legacy trust pattern is refused, or null. A pattern is a folder inside the project, or one under
// a fixed folder that is neither the project's parent nor an ancestor; "*" matches one segment
// and only as the last one.
export function trustProblem(pattern: string): string | null {
  if (CONTROL_OR_BACKTICK.test(pattern)) {
    return 'must not contain control characters or backticks';
  }
  // An absolute folder is a canonical-landing entry, such as the machine lobby.
  if (pattern.startsWith('/')) return null;
  if (pattern.startsWith('~') || /^[A-Za-z]:[\\/]/.test(pattern)) {
    return 'must be relative to the project, or an absolute folder';
  }
  const segments = normalize(pattern).split('/');
  const last = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (segment.includes('*') && (segment !== '*' || i !== last)) return 'takes "*" only as a whole last segment';
  }
  const fixed = segments[last] === '*' ? segments.slice(0, last) : segments;
  if (fixed.length && fixed.every((segment) => segment === '..')) {
    return segments[last] === '*'
      ? 'would trust every folder beside the project or above it: name a fixed folder before "*"'
      : 'is a parent of the project: trust a folder of the team\'s own';
  }
  return null;
}

/** True when `folder` is a proper ancestor of `of`. Both are absolute and resolved. */
function above(folder: string, of: string): boolean {
  return folder !== of && of.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** True when `folder` is a proper ancestor of the project root, spelled or canonical. */
function projectAncestor(folder: string, root: string, fs: FsReader): boolean {
  if (above(folder, resolve(root))) return true;
  try {
    return above(folder, fs.realpath(resolve(root)));
  } catch {
    return false;
  }
}

/**
 * Why an absolute trust entry is refused, or null.
 * An absolute trust entry must start with / or ~, contain no glob, no . or .. segment,
 * no control characters or backticks, must not contain the home, the lobby or the approval
 * store, nor be a parent of the project when the root is known, and its parent walk must
 * reach an existing directory without meeting a symbolic link (dangling or not).
 *
 * Containment compares what an entry names, not how it is spelled: the entry's landing — the
 * real path of its deepest existing ancestor, the rest as written — is compared against the
 * canonical home, lobby and project ancestors as well, so on a volume that folds case or a
 * Unicode normalisation form a second spelling of a refused folder is refused too. When the
 * landing meets a symbolic link or a read error the written form decides and the walk below
 * names it; an entry that exists nowhere keeps its tail as written, under its existing folder.
 */
export function absoluteTrustProblem(entry: string, home: string = homedir(), fs: FsReader = defaultFs, root?: string): string | null {
  if (CONTROL_OR_BACKTICK.test(entry)) {
    return 'must not contain control characters or backticks';
  }
  if (isLegacyTrustEntry(entry)) {
    return 'must be an absolute path or start with "~"';
  }
  if (entry.includes('~')) {
    if (!entry.startsWith('~') || (entry.length > 1 && !entry.startsWith('~/'))) {
      return 'takes "~" only as the first component';
    }
    if (entry.slice(1).includes('~')) {
      return 'takes "~" only as the first component';
    }
  }
  if (/[*?[\]{}]/.test(entry)) {
    return 'must not contain glob characters';
  }
  const rawSegments = entry.split('/');
  if (rawSegments.some((seg) => seg === '.' || seg === '..')) {
    return 'must not contain "." or ".."';
  }
  const expanded = resolve(entry.replace(/^~(?=$|\/)/, home));
  const homeResolved = resolve(home);
  const landing = canonicalLanding(expanded, fs);
  // A symbolic link or a read error keeps the written form here: the walk below names it.
  const named = landing.symlink === undefined && landing.error === undefined ? landing.landing : expanded;
  const homeNamed = canonicalLanding(homeResolved, fs).landing;
  const lobbyNamed = canonicalLanding(lobbyDir(homeResolved), fs).landing;
  const folds = named !== expanded;

  // Containment: an entry names a folder of the team's own. It is never the root, the home, a
  // folder above the home — the lobby's folder holds the lobby and the approval store — or a
  // folder above the project; main's legacy checker refused these shapes.
  if (expanded === sep) return 'is the root of the filesystem: trust a folder of the team\'s own';
  if (expanded === homeResolved || named === homeNamed) return 'is the home itself: trust a folder of the team\'s own';
  if (above(expanded, lobbyDir(homeResolved)) || (folds && above(named, lobbyNamed))) {
    return `would cover ${join(homeResolved, '.config', 'team')}, which holds the lobby and the approval store: trust a folder of the team's own`;
  }
  if (root !== undefined && (projectAncestor(expanded, root, fs) || (folds && projectAncestor(named, root, fs)))) {
    return 'is a parent of the project: trust a folder of the team\'s own';
  }

  const underHome = expanded === homeResolved || expanded.startsWith(homeResolved.endsWith(sep) ? homeResolved : homeResolved + sep);
  // Ancestors of the home are not the lobby chain. A volume symlink above the home
  // (macOS `/var`) is not a link in the entry.
  const segments = (underHome ? expanded.slice(homeResolved.length) : expanded).split(sep).filter(Boolean);
  let built = underHome ? homeResolved : expanded.startsWith(sep) ? sep : '';
  let hitMissing = false;
  if (underHome) {
    try {
      const stat = fs.lstat(homeResolved);
      if (stat.isSymbolicLink()) return `${homeResolved} is a symbolic link`;
      if (!stat.isDirectory()) return `${homeResolved} is not a directory`;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') return `cannot read ${homeResolved}: ${err?.code ?? err?.message}`;
      hitMissing = true;
    }
  }

  for (const seg of segments) {
    built = join(built, seg);
    let stat: FsStats;
    try {
      stat = fs.lstat(built);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        hitMissing = true;
        continue;
      }
      return `cannot read ${built}: ${err?.code ?? err?.message}`;
    }
    if (hitMissing) {
      if (stat.isSymbolicLink()) {
        return `${built} is a symbolic link`;
      }
      return `${built} is not a directory`;
    }
    if (stat.isSymbolicLink()) {
      return `${built} is a symbolic link`;
    }
    if (!stat.isDirectory()) {
      if (built === expanded) {
        return 'is not a directory';
      }
      return `${built} is not a directory`;
    }
  }
  return null;
}

// The folder a pattern keeps fixed: the pattern without its trailing "*".
export function fixedFolder(pattern: string): string {
  const segments = normalize(pattern).split('/');
  if (segments[segments.length - 1] === '*') segments.pop();
  return segments.join('/') || '.';
}

// The protected checkout `path` is in, or null. A checkout named "." is the project root, so every
// path inside the project is inside it; every other entry names that folder and what lies under it.
export function protectedBy(path: string, checkouts: readonly string[]): string | null {
  const target = normalize(path);
  for (const checkout of checkouts) {
    const folder = normalize(checkout);
    if (folder === '.') {
      if (insideProject(target)) return checkout;
      continue;
    }
    if (target === folder || target.startsWith(`${folder}/`)) return checkout;
  }
  return null;
}

/**
 * Resolves the deepest existing ancestor with realpath, and appends the non-existent tail unchanged.
 * If any component (including dangling links) along the path is a symbolic link, returns symlink.
 */
export function canonicalLanding(
  path: string, fs: FsReader = defaultFs,
): { landing: string; symlink?: string; error?: { path: string; code: string } } {
  const logical = resolve(path);
  const segments = logical.split(sep).filter(Boolean);
  let built = logical.startsWith(sep) ? sep : '';
  let deepestExisting = built;
  const tail: string[] = [];
  let foundSymlink: string | undefined;
  let hitMissing = false;

  const fail = (at: string, err: unknown) => ({
    landing: logical,
    error: { path: at, code: String((err as { code?: string; message?: string })?.code ?? (err as { message?: string })?.message ?? 'unknown') },
  });

  for (const seg of segments) {
    built = join(built, seg);
    if (!hitMissing) {
      try {
        const stat = fs.lstat(built);
        if (stat.isSymbolicLink()) foundSymlink = built;
        deepestExisting = built;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'ENOENT') return fail(built, err);
        hitMissing = true;
        tail.push(seg);
      }
    } else {
      try {
        const stat = fs.lstat(built);
        if (stat.isSymbolicLink() && !foundSymlink) foundSymlink = built;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'ENOENT') return fail(built, err);
      }
      tail.push(seg);
    }
  }

  let real: string;
  try {
    real = deepestExisting === sep || deepestExisting === '' ? deepestExisting || sep : fs.realpath(deepestExisting);
  } catch (err) {
    return fail(deepestExisting, err);
  }
  return {
    landing: tail.length ? join(real, ...tail) : real,
    ...(foundSymlink ? { symlink: foundSymlink } : {}),
  };
}

// True when `path` is a trusted folder or lies under one.
export function insideTrust(path: string, patterns: readonly string[], root?: string, home: string = homedir(), fs: FsReader = defaultFs): boolean {
  if (patterns.length === 0) return false;
  if (isMigratedTrust(patterns)) {
    const target = (root && !path.startsWith('/') && !path.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(path))
      ? resolve(root, path)
      : resolve(path.replace(/^~(?=$|\/)/, home));
    const targetLanding = canonicalLanding(target, fs);
    if (targetLanding.error || targetLanding.symlink) return false;
    return patterns.some((pattern) => {
      const expanded = resolve(pattern.replace(/^~(?=$|\/)/, home));
      const patternLanding = canonicalLanding(expanded, fs);
      if (patternLanding.error || patternLanding.symlink) return false;
      const t = targetLanding.landing;
      const p = patternLanding.landing;
      return t === p || t.startsWith(p.endsWith(sep) ? p : p + sep);
    });
  }
  const target = normalize(path).split('/');
  return patterns.some((pattern) => {
    // An absolute entry is an exact landing, compared by `canonicalLanding`, never by this prefix.
    if (pattern.startsWith('/')) return false;
    if (trustProblem(pattern)) return false;
    const segments = normalize(pattern).split('/');
    if (segments.length === 1 && segments[0] === '.') return insideProject(path);
    if (target.length < segments.length) return false;
    return segments.every((segment, i) => segment === '*' || segment === target[i]);
  });
}
