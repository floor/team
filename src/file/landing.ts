import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** The one folder every seat starts in: `<home>/.config/team/lobby`. */
export function lobbyPath(home: string): string {
  return join(home, '.config', 'team', 'lobby');
}

/**
 * The canonical landing of a folder: the deepest existing ancestor, resolved with
 * `realpath`, plus the tail that does not exist yet, unchanged. A symbolic link in
 * any existing component is refused — the path is not that folder.
 * Null when a component is a link, or the existing ancestor cannot be resolved.
 */
export function canonicalLanding(path: string): string | null {
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter((segment) => segment !== '');
  let built = absolute.startsWith(sep) ? sep : '';
  let existing = 0;
  for (let index = 0; index < segments.length; index++) {
    const next = built === sep ? join(sep, ...segments.slice(0, index + 1)) : join(built, segments[index] as string);
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) return null;
    built = next;
    existing = index + 1;
  }
  if (existing === 0 && built !== sep) return null;
  let landed: string;
  try {
    landed = realpathSync(built);
  } catch {
    return null;
  }
  const tail = segments.slice(existing);
  return tail.length === 0 ? landed : join(landed, ...tail);
}

/** An absolute folder as written, or a project-relative one resolved from the root. */
export function folderOf(entry: string, root: string): string {
  return isAbsolute(entry) ? entry : resolve(root, entry);
}
