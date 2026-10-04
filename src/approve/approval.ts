import { homedir } from 'node:os';
import type { ApprovedCheck } from '../budgets/checks.ts';
import type { TeamFile } from '../file/types.ts';
import { defaultBudgets, defaultWatch, validateTeamFile } from '../file/validate.ts';
import { readApproval, storePath, type Approval, type ApprovalRecord, type Ceilings } from '../store/store.ts';
import { compare, describe, fingerprints, OWNER_SECTIONS, type Fingerprints } from './fingerprint.ts';

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
 * An approval's fingerprints, with the sections a record written before them has none for read
 * from the copy it stored: `watch` and `watch.checks` arrived after records did, and the section's
 * arrival alone is not a difference — an approval recorded before it stays valid while the section
 * is unchanged (as `watch.checks` has since #48). A copy that can't be read leaves the record as
 * it is, and the section reads as a difference.
 */
export function approvedFingerprints(record: ApprovalRecord): Fingerprints {
  const stored = record.approval.fingerprints;
  if (OWNER_SECTIONS.every((name) => stored.sections[name] !== undefined)) return stored;
  const checked = validateTeamFile(record.file);
  if (!checked.ok) return stored;
  return { sections: { ...fingerprints(checked.team).sections, ...stored.sections }, seats: stored.seats };
}

/**
 * What in the file the owner has not approved on this machine, one line per
 * difference. Empty when the file is the approved one; null when nothing was
 * ever approved for this root. A file runs only when this is empty.
 */
export function approvalDifferences(team: TeamFile, root: string, home: string = homedir()): string[] | null {
  const record = readApproval(storePath(team.project, root, home));
  if (record === null) return null;
  return compare(approvedFingerprints(record), fingerprints(team)).map(describe);
}

/**
 * The watch values in force. The watch section is the owner's, so what a file sets takes effect
 * only once the owner has approved it: a file never approved runs with the defaults, and a file
 * whose `watch` section differs from the approved one runs with the values of the approved copy.
 * An edit to a threshold changes nothing until `approve`.
 *
 * `watch.checks` is the finer line inside that section. Whenever its digest differs, the checks
 * in force are the approved copy's — or none, when that copy can't be read — even when the
 * timings themselves are unchanged and the rest of the section is the file's.
 */
export function watchInForce(team: TeamFile, root: string, home: string = homedir()): TeamFile['watch'] {
  const record = readApproval(storePath(team.project, root, home));
  if (record === null) return defaultWatch();
  const differences = compare(approvedFingerprints(record), fingerprints(team));
  const timingsDiffer = differences.some((difference) => difference.kind === 'section' && difference.name === 'watch');
  const checksDiffer = differences.some((difference) => difference.kind === 'section' && difference.name === 'watch.checks');
  if (!timingsDiffer && !checksDiffer) return team.watch;
  const copy = validateTeamFile(record.file);
  const approved = copy.ok ? copy.team.watch : defaultWatch();
  if (!timingsDiffer) return { ...team.watch, checks: approved.checks };
  return approved;
}

/**
 * The budget values in force. The `budgets` section is the owner's like the watch's, so what a
 * file sets takes effect only once the owner has approved it: a file never approved runs with the
 * defaults — no accounts — and a file whose `budgets` section differs from the approved one runs
 * with the values of the approved copy, accounts included. An unapproved edit — a reserve lowered,
 * a mark dropped, `check_every` stretched, an account taken out — silences nothing and unblocks
 * nothing until `approve`.
 */
export function budgetsInForce(team: TeamFile, root: string, home: string = homedir()): TeamFile['budgets'] {
  const record = readApproval(storePath(team.project, root, home));
  if (record === null) return defaultBudgets();
  if (approvedFingerprints(record).sections['budgets'] === fingerprints(team).sections['budgets']) return team.budgets;
  const copy = validateTeamFile(record.file);
  return copy.ok ? copy.team.budgets : defaultBudgets();
}
