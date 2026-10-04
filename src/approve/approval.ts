import { homedir } from 'node:os';
import { checkDrift, resolveChecks, type ApprovedCheck } from '../budgets/checks.ts';
import type { TeamFile } from '../file/types.ts';
import { readApproval, storePath, type Approval, type Ceilings } from '../store/store.ts';
import { compare, describe, fingerprints } from './fingerprint.ts';

/** The ceilings an approval fixes: `up` and `add` read them from the record, never from the file. */
export function ceilingsOf(team: TeamFile): Ceilings {
  return { seats: team.limits.seats, temporary: team.limits.temporary, vendors: { ...team.limits.vendors } };
}

/** The record an approval of this file writes. */
export function approvalOf(
  team: TeamFile,
  root: string,
  now: Date = new Date(),
  checks: Record<string, ApprovedCheck> = {},
): Approval {
  return {
    format: 1,
    approvedAt: now.toISOString(),
    root,
    fingerprints: fingerprints(team),
    ceilings: ceilingsOf(team),
    checks,
  };
}

/**
 * What in the file the owner has not approved on this machine, one line per
 * difference. Empty when the file is the approved one; null when nothing was
 * ever approved for this root. A file runs only when this is empty.
 */
export function approvalDifferences(team: TeamFile, root: string, home: string = homedir()): string[] | null {
  const record = readApproval(storePath(team.project, root, home));
  if (record === null) return null;
  const lines = compare(record.approval.fingerprints, fingerprints(team)).map(describe);
  const pathEnv = process.env.PATH ?? '';
  const resolved = resolveChecks(team, root, pathEnv);
  if (!resolved.ok) lines.push(`the check for ${resolved.account} cannot be resolved`);
  else lines.push(...checkDrift(record.approval.checks, resolved.checks));
  return lines;
}
