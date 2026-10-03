import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readState, updateState } from '../state.ts';
import { loadTeamFile } from './load.ts';
import type { Problem, TeamFile } from './types.ts';
import { validateTeamFile } from './validate.ts';

// The team as the commands that must keep working read it: `status`, `watch`, `down`. A valid
// file is remembered in the state; a broken one is replaced by the last copy that validated,
// with a notice to print first. Commands that launch or change anything use loadTeamFile and
// refuse instead.
export type Current =
  | { ok: true; team: TeamFile; root: string; dir: string; warnings: Problem[]; notice?: string }
  | { ok: false; errors: Problem[] };

export function currentTeam(cwd: string, file: string | undefined, now: Date): Current {
  const loaded = loadTeamFile(cwd, file ? { file } : {});
  if (loaded.ok) {
    const dir = dirname(loaded.path);
    remember(dir, loaded.path, now);
    return { ok: true, team: loaded.team, root: loaded.root, dir, warnings: loaded.warnings };
  }
  if (!loaded.path || !existsSync(loaded.path)) return { ok: false, errors: loaded.errors };
  const dir = dirname(loaded.path);
  const saved = lastValid(dir);
  if (!saved) return { ok: false, errors: loaded.errors };
  const first = loaded.errors[0];
  return {
    ok: true,
    team: saved.team,
    root: dir.endsWith('.agents') ? dirname(dir) : dir,
    dir,
    warnings: [],
    notice: `team.yaml is invalid (${first && first.line ? `line ${first.line}: ` : ''}${first?.message ?? 'unreadable'}); using the copy of ${saved.readAt}`,
  };
}

function remember(dir: string, path: string, now: Date): void {
  const file = readFileSync(path, 'utf8');
  try {
    if (readState(dir).last_valid?.file === file) return;
    updateState(dir, (state) => {
      state.last_valid = { read_at: now.toISOString(), file };
    });
  } catch {
    // A state that can't be written must not stop a command that only reads.
  }
}

function lastValid(dir: string): { team: TeamFile; readAt: string } | null {
  try {
    const saved = readState(dir).last_valid;
    if (!saved) return null;
    const result = validateTeamFile(saved.file);
    return result.ok ? { team: result.team, readAt: saved.read_at } : null;
  } catch {
    return null;
  }
}
