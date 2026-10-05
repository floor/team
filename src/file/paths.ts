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
  if (pattern.startsWith('/') || pattern.startsWith('~') || /^[A-Za-z]:[\\/]/.test(pattern)) {
    return 'must be relative to the project';
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

/**
 * Why an absolute trust entry is refused, or null.
 * An absolute trust entry must start with / or ~, contain no glob, no . or .. segment,
 * no control characters or backticks, and its parent walk must reach an existing directory
 * without meeting a symbolic link (dangling or not).
 */
export function absoluteTrustProblem(entry: string, home: string = homedir(), fs: FsReader = defaultFs): string | null {
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
  if (expanded === lobbyDir(home)) {
    return null;
  }
  const segments = expanded.split(sep).filter(Boolean);
  let built = expanded.startsWith(sep) ? sep : '';
  let hitMissing = false;

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
export function canonicalLanding(path: string, fs: FsReader = defaultFs): { landing: string; symlink?: string } {
  const logical = resolve(path);
  const segments = logical.split(sep).filter(Boolean);
  let built = logical.startsWith(sep) ? sep : '';
  let deepestExisting = built;
  const tail: string[] = [];
  let foundSymlink: string | undefined;
  let hitMissing = false;

  for (const seg of segments) {
    built = join(built, seg);
    if (!hitMissing) {
      try {
        const stat = fs.lstat(built);
        if (stat.isSymbolicLink()) {
          foundSymlink = built;
        }
        deepestExisting = built;
      } catch {
        hitMissing = true;
        tail.push(seg);
      }
    } else {
      try {
        const stat = fs.lstat(built);
        if (stat.isSymbolicLink()) {
          if (!foundSymlink) foundSymlink = built;
        }
      } catch {}
      tail.push(seg);
    }
  }

  let real: string;
  try {
    real = fs.realpath(deepestExisting);
  } catch {
    real = deepestExisting;
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
    if (targetLanding.symlink) return false;
    return patterns.some((pattern) => {
      const expanded = resolve(pattern.replace(/^~(?=$|\/)/, home));
      const patternLanding = canonicalLanding(expanded, fs);
      if (patternLanding.symlink) return false;
      const t = targetLanding.landing;
      const p = patternLanding.landing;
      return t === p || t.startsWith(p.endsWith(sep) ? p : p + sep);
    });
  }
  const target = normalize(path).split('/');
  return patterns.some((pattern) => {
    if (trustProblem(pattern)) return false;
    const segments = normalize(pattern).split('/');
    if (segments.length === 1 && segments[0] === '.') return insideProject(path);
    if (target.length < segments.length) return false;
    return segments.every((segment, i) => segment === '*' || segment === target[i]);
  });
}
