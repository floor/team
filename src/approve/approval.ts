import { homedir } from 'node:os';
import type { ApprovedCheck } from '../budgets/checks.ts';
import type { TeamFile } from '../file/types.ts';
import { defaultBudgets, defaultWatch, validateTeamFile } from '../file/validate.ts';
import { readApproval, storePath, writeApproval, type Approval, type ApprovalRecord, type Ceilings } from '../store/store.ts';
import { compare, describe, fingerprints, legacySeatDigests, OWNER_SECTIONS, type Fingerprints } from './fingerprint.ts';

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
  const checked = validateTeamFile(record.file);
  let sections = stored.sections;
  if (!OWNER_SECTIONS.every((name) => stored.sections[name] !== undefined) && checked.ok) {
    sections = { ...fingerprints(checked.team).sections, ...stored.sections };
  }
  const seats = checked.ok ? adoptFlagDigests(stored.seats, checked.team) : stored.seats;
  if (sections === stored.sections && seats === stored.seats) return stored;
  return { sections, seats };
}

/**
 * A record from before `parked` and `stopped` were in the digest still names
 * the seat as it was approved, flags included, read from the stored copy. A
 * digest already in the new shape is left alone, so a later edit of the file
 * is not adopted from a stale copy. A copy that can't be read is left alone.
 */
function adoptFlagDigests(stored: Record<string, string>, team: TeamFile): Record<string, string> {
  const current = fingerprints(team).seats;
  const legacy = legacySeatDigests(team);
  let changed = false;
  const next = { ...stored };
  for (const [name, previous] of Object.entries(stored)) {
    const adopted = current[name];
    if (adopted !== undefined && previous === legacy[name] && previous !== adopted) {
      next[name] = adopted;
      changed = true;
    }
  }
  return changed ? next : stored;
}

/**
 * `remove --keep` and `add` write `stopped` and nothing else. The new digest is
 * recorded only when putting `stopped` back to its approved value makes the
 * seat match the approval. A launch line or a `parked` flag edited beside the
 * mark stays drift. A stored copy that can't be read records nothing.
 */
export function recordSeatDigest(team: TeamFile, root: string, name: string, home: string = homedir()): void {
  const store = storePath(team.project, root, home);
  const record = readApproval(store);
  if (record === null) return;
  if (!validateTeamFile(record.file).ok) return;
  const approved = approvedFingerprints(record).seats[name];
  const digest = fingerprints(team).seats[name];
  if (approved === undefined || digest === undefined || record.approval.fingerprints.seats[name] === digest) return;
  const withStopped = (stopped: boolean) => fingerprints({
    ...team,
    seats: team.seats.map((seat) => (seat.name === name ? { ...seat, stopped } : seat)),
  }).seats[name];
  if (withStopped(true) !== approved && withStopped(false) !== approved) return;
  writeApproval(store, {
    approval: {
      ...record.approval,
      fingerprints: {
        ...record.approval.fingerprints,
        seats: { ...record.approval.fingerprints.seats, [name]: digest },
      },
    },
    file: record.file,
  }, []);
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
 */
export function watchInForce(team: TeamFile, root: string, home: string = homedir()): TeamFile['watch'] {
  const record = readApproval(storePath(team.project, root, home));
  if (record === null) return defaultWatch();
  if (approvedFingerprints(record).sections['watch'] === fingerprints(team).sections['watch']) return team.watch;
  const copy = validateTeamFile(record.file);
  return copy.ok ? copy.team.watch : defaultWatch();
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
