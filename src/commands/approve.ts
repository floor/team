import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { approvalOf, ceilingsOf } from '../approve/approval.ts';
import { formatDiff } from '../approve/diff.ts';
import { compare, describe, fingerprints } from '../approve/fingerprint.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { loadTeamFile, placedProblems } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { readApproval, storePath, writeApproval, type Ceilings } from '../store/store.ts';

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

const USAGE = 'Usage: team approve [--show] [--file <path>]\n';

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
function storeProblem(store: string, root: string, team: TeamFile): string | null {
  const place = real(dirname(store));
  const folders = [root, ...team.trust.map((pattern) => resolve(root, pattern.replace(/\/?\*$/, '')))];
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
    return 2;
  }

  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team approve: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  // Validate the text load just read. A second read could store an edit under the first read's fingerprints.
  const checked = validateTeamFile(loaded.text);
  if (!checked.ok) {
    for (const problem of checked.errors) {
      io.stderr(`team approve: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  const placed = placedProblems(checked.team, loaded.root);
  if (placed.length) {
    for (const problem of placed) io.stderr(`team approve: ${problem.message}\n`);
    return 2;
  }
  const { team } = checked;
  const { root, path } = loaded;
  const text = loaded.text;
  for (const warning of checked.warnings) io.stderr(`team approve: warning, line ${warning.line}: ${warning.message}\n`);

  const store = storePath(team.project, root, sources.home);
  const problem = storeProblem(store, root, team);
  if (problem) {
    io.stderr(`team approve: ${problem}\n`);
    return 1;
  }

  const previous = readApproval(store);
  const ceilings = ceilingsOf(team);
  const seats = team.seats.length;

  if (previous === null) {
    io.stdout(`${path}: never approved on this machine. The whole file:\n\n`);
    io.stdout(
      `${text
        .replace(/\n$/, '')
        .split('\n')
        .map((line, index) => `  ${index + 1}: ${line}`)
        .join('\n')}\n\n`,
    );
  } else {
    const changes = compare(previous.approval.fingerprints, fingerprints(team)).map(describe);
    const lines = formatDiff(previous.file, text);
    if (lines.length === 0)
      io.stdout(`${path}: the same text as the copy approved on ${previous.approval.approvedAt}.\n\n`);
    else {
      io.stdout(`${path}: against the copy approved on ${previous.approval.approvedAt}:\n\n`);
      io.stdout(`${lines.map((line) => `  ${line}`).join('\n')}\n\n`);
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

  if (args.flags.has('show')) return 0;

  const caller = callerOf(io);
  if (!isOwner(caller)) {
    io.stderr(
      `team approve: only the owner approves a team file, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`,
    );
    return 1;
  }

  const answer = await sources.ask(
    `\nType the number of seats (${seats}) to approve this file, and its commands and rules, to run: `,
  );
  if (answer === null || answer.trim() !== String(seats)) {
    io.stderr('team approve: not approved; nothing was written\n');
    return 1;
  }

  const now = sources.now();
  writeApproval(store, { approval: approvalOf(team, root, now), file: text }, team.seats);
  logLine(
    dirname(path),
    'approve',
    describeCaller(caller),
    `approved ${seats} seats; ceilings: ${ceilingsLine(ceilings)}`,
    now,
  );
  io.stdout(`Approved. The record is in ${store}; check the rest with \`team doctor\`.\n`);
  return 0;
}
