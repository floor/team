import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

// Paths in a team file are relative to the project's root, with "/" between segments. These
// checks are on the text alone; symlinks are resolved when trust is applied.

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
 * and its parent walk must reach an existing directory without meeting a symbolic link.
 */
export function absoluteTrustProblem(entry: string, home: string = homedir()): string | null {
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
  const segments = expanded.split(sep).filter(Boolean);
  let built = expanded.startsWith(sep) ? sep : '';
  for (const seg of segments) {
    built = join(built, seg);
    if (existsSync(built)) {
      try {
        const stat = lstatSync(built);
        if (stat.isSymbolicLink()) {
          return `${built} is a symbolic link`;
        }
        if (built === expanded && !stat.isDirectory()) {
          return 'is not a directory';
        }
      } catch {
        // ignore read error
      }
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
 * If any existing component along the ancestor walk is a symbolic link, returns symlink.
 */
export function canonicalLanding(path: string): { landing: string; symlink?: string } {
  const logical = resolve(path);
  const tail: string[] = [];
  let current = logical;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return { landing: logical };
    tail.push(basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  let symlink: string | undefined;
  const segments = current.split(sep).filter(Boolean);
  let built = current.startsWith(sep) ? sep : '';
  for (const seg of segments) {
    built = join(built, seg);
    try {
      if (lstatSync(built).isSymbolicLink()) {
        symlink = built;
        break;
      }
    } catch {}
  }
  return { landing: join(real, ...tail.reverse()), ...(symlink ? { symlink } : {}) };
}

// True when `path` is a trusted folder or lies under one.
export function insideTrust(path: string, patterns: readonly string[], root?: string, home: string = homedir()): boolean {
  if (patterns.length === 0) return false;
  if (isMigratedTrust(patterns)) {
    const target = (root && !path.startsWith('/') && !path.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(path))
      ? resolve(root, path)
      : resolve(path.replace(/^~(?=$|\/)/, home));
    const targetLanding = canonicalLanding(target).landing;
    return patterns.some((pattern) => {
      const expanded = resolve(pattern.replace(/^~(?=$|\/)/, home));
      const patternLanding = canonicalLanding(expanded).landing;
      return targetLanding === patternLanding || targetLanding.startsWith(patternLanding.endsWith(sep) ? patternLanding : patternLanding + sep);
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
