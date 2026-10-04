// A `check` command is resolved and hashed at approval. The hash is of the named
// file only. team never reads what that file imports, and never logs its bytes.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TeamFile } from '../file/types.ts';

export type ApprovedCheck = {
  command: string;
  path: string;
  hash: string;
};

export function checkCommands(team: TeamFile): { account: string; command: string }[] {
  return Object.entries(team.budgets.accounts)
    .filter((entry): entry is [string, typeof entry[1] & { check: string }] => entry[1].check !== null)
    .map(([account, accountBudget]) => ({ account, command: accountBudget.check }));
}

/** The file a command names, and its sha256. Null when it cannot be resolved. */
export function resolveCheck(command: string, root: string, pathEnv: string): { path: string; hash: string } | null {
  const path = command.includes('/')
    ? (isAbsolute(command) ? command : resolve(root, command))
    : pathEnv.split(':').filter(Boolean).map((dir) => join(dir, command)).find((file) => executable(file)) ?? '';
  if (!path || !executable(path)) return null;
  return { path, hash: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

export function resolveChecks(
  team: TeamFile,
  root: string,
  pathEnv: string,
): { ok: true; checks: Record<string, ApprovedCheck> } | { ok: false; account: string; command: string } {
  const checks: Record<string, ApprovedCheck> = {};
  for (const { account, command } of checkCommands(team)) {
    const found = resolveCheck(command, root, pathEnv);
    if (!found) return { ok: false, account, command };
    checks[account] = { command, path: found.path, hash: found.hash };
  }
  return { ok: true, checks };
}

/** Lines for a resolved command whose path or hash is not the approved one. */
export function checkDrift(approved: Record<string, ApprovedCheck> | undefined, current: Record<string, ApprovedCheck>): string[] {
  const lines: string[] = [];
  const previous = approved ?? {};
  for (const [account, check] of Object.entries(current)) {
    const known = previous[account];
    if (!known || known.command !== check.command || known.path !== check.path || known.hash !== check.hash) {
      lines.push(`the check for ${account} changed`);
    }
  }
  for (const account of Object.keys(previous)) {
    if (!current[account]) lines.push(`the check for ${account} changed`);
  }
  return lines;
}

function executable(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
