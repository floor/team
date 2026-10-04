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

// Why a trust pattern is refused, or null. A pattern is a folder inside the project, or one under
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

// True when `path` is a trusted folder or lies under one.
export function insideTrust(path: string, patterns: string[]): boolean {
  const target = normalize(path).split('/');
  return patterns.some((pattern) => {
    if (trustProblem(pattern)) return false;
    const segments = normalize(pattern).split('/');
    if (segments.length === 1 && segments[0] === '.') return insideProject(path);
    if (target.length < segments.length) return false;
    return segments.every((segment, i) => segment === '*' || segment === target[i]);
  });
}
