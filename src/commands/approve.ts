import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { approvedFingerprints, approvalOf, ceilingsOf } from '../approve/approval.ts';
import { checkDrift, resolveChecks } from '../budgets/checks.ts';
import { formatDiff } from '../approve/diff.ts';
import { compare, describe, fingerprints } from '../approve/fingerprint.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { OVERRIDE_CHANGED, overrideFile } from '../profiles/overrides.ts';
import { approvalStanding, LEGACY_LINE, readApproval, storePath, writeApproval, type Ceilings } from '../store/store.ts';
import { keyFingerprint, keyOf, keyState, recordedGeneration } from '../store/keys.ts';

// What `approve` reads from outside the file, so tests can stand in for it.
export type ApproveSources = {
  // The owner's answer to a question on the terminal, or null when there is none.
  ask(question: string): Promise<string | null>;
  now(): Date;
  home: string;
};

export const realSources: ApproveSources = {
  async ask(question) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await terminal.question(question);
    } catch {
      return null;
    } finally {
      terminal.close();
    }
  },
  now: () => new Date(),
  home: homedir(),
};

export const USAGE = 'Usage: team approve [--show] [--file <path>]\n';

export const approve: Command = (argv, io) => runApprove(argv, io, realSources);
export default approve;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

// The store must stay out of the project and of every folder a seat may work in.
function expandTrustEntry(pattern: string, root: string, home: string): string {
  const trimmed = pattern.replace(/\/?\*$/, '');
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return resolve(trimmed.replace(/^~(?=$|\/)/, home));
  return resolve(root, trimmed);
}

function storeProblem(store: string, root: string, team: TeamFile, home: string): string | null {
  const place = real(dirname(store));
  const folders = [root, ...team.trust.map((pattern) => expandTrustEntry(pattern, root, home))];
  const holder = folders.map(real).find((folder) => inside(place, folder) || inside(store, folder));
  return holder === undefined ? null : `the approval store ${store} is inside ${holder}, where seats work`;
}

function ceilingsLine(ceilings: Ceilings): string {
  const vendors = Object.entries(ceilings.vendors).map(([vendor, count]) => `${vendor} ${count}`);
  return [`${ceilings.seats} seats at most`, `${ceilings.temporary} temporary`, ...vendors].join(', ');
}

export async function runApprove(argv: string[], io: Io, sources: ApproveSources): Promise<number> {
  const args = readArgs(argv, ['file'], ['show']);
  if (args.error || args.rest.length) {
    io.stderr(`team approve: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: approve.invocation
    return 2;
  }

  const loaded = loadTeamFile(io.cwd, { ...(args.values.file ? { file: args.values.file } : {}), home: sources.home });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team approve: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: approve.not-a-repo
    // exit: approve.file
    // exit: approve.file-invalid
    return 2;
  }
  // Validate the text load just read, against the same home and root the load used. A second read
  // could store an edit under the first read's fingerprints.
  const checked = validateTeamFile(loaded.text, { home: sources.home, root: loaded.root });
  if (!checked.ok) {
    for (const problem of checked.errors) {
      io.stderr(`team approve: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: approve.revalidate
    return 2;
  }
  const placed = placedProblems(checked.team, loaded.root, sources.home);
  if (placed.length) {
    for (const problem of placed) io.stderr(`team approve: ${problem.message}\n`);
    // exit: approve.placed
    return 2;
  }
  const { team } = checked;
  const { root, path } = loaded;
  const text = loaded.text;
  for (const warning of checked.warnings) io.stderr(`team approve: warning, line ${warning.line}: ${warning.message}\n`);

  const store = storePath(team.project, root, sources.home);
  const live = overrideFile(team.project, root, sources.home);
  if (live.problems.length) {
    for (const problem of live.problems) io.stderr(`team approve: ${problem}\n`);
    // exit: approve.overrides
    return 2;
  }
  const problem = storeProblem(store, root, team, sources.home);
  if (problem) {
    io.stderr(`team approve: ${problem}\n`);
    // exit: approve.store
    return 1;
  }

  const resolved = resolveChecks(team, root, process.env.PATH ?? '');
  if (!resolved.ok) {
    io.stderr(`team approve: the check for ${resolved.account} cannot be resolved\n`);
    // exit: approve.check
    return 1;
  }
  let previous: ReturnType<typeof readApproval> = null;
  try {
    previous = readApproval(store);
  } catch {
    // A malformed record is named by the standing below; nothing is diffed against it.
  }
  const standing = approvalStanding(root, sources.home);
  const ceilings = ceilingsOf(team);
  const seats = team.seats.length;

  if (standing.kind === 'legacy' || standing.kind === 'refused') {
    io.stdout(`Note: ${standing.kind === 'legacy' ? LEGACY_LINE : standing.why}\n`);
  }
  if (previous === null) {
    io.stdout(`${path}: never approved on this machine. The whole file:\n\n`);
    io.stdout(
      `${text
        .replace(/\n$/, '')
        .split('\n')
        .map((line, index) => (line.length ? `  ${index + 1}: ${line}` : `  ${index + 1}:`))
        .join('\n')}\n\n`,
    );
  } else {
    const changes = [
      ...compare(approvedFingerprints(previous), fingerprints(team)).map(describe),
      ...checkDrift(previous.approval.checks, resolved.checks),
      // A record that does not verify is not an approval: this one is needed whatever the diff says.
      ...(standing.kind === 'legacy' ? ['the record predates signed records'] : []),
      ...(standing.kind === 'refused' ? ['the stored record does not verify'] : []),
    ];
    const lines = formatDiff(previous.file, text);
    if (lines.length === 0)
      io.stdout(`${path}: the same text as the copy approved on ${previous.approval.approvedAt}.\n\n`);
    else {
      io.stdout(`${path}: against the copy approved on ${previous.approval.approvedAt}:\n\n`);
      io.stdout(`${lines.map((line) => `  ${line}`).join('\n')}\n\n`);
    }
    const recorded = Object.hasOwn(previous.approval, 'overrides') ? previous.approval.overrides ?? null : null;
    if (recorded !== live.text) {
      changes.push(OVERRIDE_CHANGED);
      const overrideLines = formatDiff(recorded ?? '', live.text ?? '');
      if (overrideLines.length) {
        io.stdout(`overrides.yaml: against the copy approved on ${previous.approval.approvedAt}:\n\n`);
        io.stdout(`${overrideLines.map((line) => `  ${line}`).join('\n')}\n\n`);
      }
    }
    io.stdout(
      changes.length ? `Needs a new approval: ${changes.join('; ')}.\n` : 'Nothing in it needs a new approval.\n',
    );
    if (ceilingsLine(previous.approval.ceilings) !== ceilingsLine(ceilings)) {
      io.stdout(`Ceilings approved: ${ceilingsLine(previous.approval.ceilings)}.\n`);
    }
  }
  io.stdout(`Ceilings this approval fixes: ${ceilingsLine(ceilings)}.\n`);
  io.stdout(`Seats: ${seats} (${team.seats.map((seat) => seat.name).join(', ')}).\n`);
  // One line per delegates entry, in file order; nothing when the file has no section.
  for (const delegate of team.delegates ?? []) {
    io.stdout(`Delegate: pane ${delegate.pane} may run ${delegate.commands.join(', ')}.\n`);
  }
  // The generation this signing will carry, and when the last one was, with the
  // fingerprint of the key that will sign it. A process that reads or replaces
  // the key can re-sign at the same generation, so this is evidence of what
  // `team` wrote, never of every signing.
  const recorded = recordedGeneration(root, sources.home);
  const keyRead = keyState(sources.home);
  io.stdout(
    `approval #${(recorded?.generation ?? 0) + 1} for this project${recorded ? `; the last one was on ${recorded.at.slice(0, 10)}` : ''}${keyRead.kind === 'key' ? `; key ${keyFingerprint(keyRead.key)}` : ''}.\n`,
  );

  // exit: approve.show
  if (args.flags.has('show')) return 0;

  // A key that cannot be read fails closed here, before the owner answers anything:
  // a new key would orphan every record already signed, so the owner restores it.
  try {
    keyOf(sources.home);
  } catch (error) {
    io.stderr(`team approve: ${(error as Error).message}\n`);
    // exit: approve.key
    return 1;
  }

  const caller = callerOf(io);
  if (!isOwner(caller)) {
    io.stderr(
      `team approve: only the owner approves a team file, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`,
    );
    // exit: approve.not-owner
    return 1;
  }

  const answer = await sources.ask(
    `\nType the number of seats (${seats}) to approve this file, and its commands and rules, to run: `,
  );
  if (answer === null || answer.trim() !== String(seats)) {
    io.stderr('team approve: not approved; nothing was written\n');
    // exit: approve.answer
    return 1;
  }

  const now = sources.now();
  writeApproval(
    store,
    { approval: { ...approvalOf(team, root, now, resolved.checks), overrides: live.text }, file: text },
    team.seats,
    sources.home,
    now,
  );
  logLine(
    dirname(path),
    'approve',
    describeCaller(caller),
    `approved ${seats} seats; ceilings: ${ceilingsLine(ceilings)}`,
    now,
  );
  io.stdout(`Approved. The record is in ${store}; signed with key ${keyFingerprint(keyOf(sources.home))}; check the rest with \`team doctor\`.\n`);
  // exit: approve.approved
  return 0;
}
