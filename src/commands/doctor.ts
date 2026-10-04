import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { approvalDifferences, budgetsInForce, watchInForce } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { checkReadings } from '../budgets/checks.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { HERDR_TESTED, herdrVersion, sessionRunning } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { profileFor } from '../profiles/index.ts';
import { versionVerdict, type Profile } from '../profiles/profile.ts';
import { readState } from '../state.ts';
import { readApproval, storePath } from '../store/store.ts';

// What `doctor` reads from the machine, so tests can stand in for it.
export type DoctorSources = {
  // What `<binary> --version` prints, or null when the binary can't be run.
  version(binary: string): string | null;
  // Whether a command is an executable on the PATH. A seat's launcher is never run to find out.
  onPath(binary: string): boolean;
  // Whether the owner is logged in to a CLI; null when this version can't tell.
  loggedIn(profile: Profile): boolean | null;
  herdrVersion(): string | null;
  sessionRunning(session: string): boolean | null;
  now(): Date;
  home: string;
};

export type CommandRunner = (binary: string, args: string[]) => { status: number | null; stdout: string } | null;

export function run(binary: string, args: string[]): { status: number | null; stdout: string } | null {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  return result.error ? null : { status: result.status, stdout: result.stdout };
}

export const realCommandRunner = run;

export function checkLogin(profile: Profile, runner: CommandRunner = run): boolean | null {
  if (!profile.loginCheck) return null;
  // Only the exit code is read: the output names the account.
  const result = runner(profile.binary, [...profile.loginCheck]);
  return result ? result.status === 0 : null;
}

export const realSources: DoctorSources = {
  version(binary) {
    const result = run(binary, ['--version']);
    return result && result.status === 0 ? result.stdout.trim() : null;
  },
  onPath(binary) {
    const folders = isAbsolute(binary) ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    return folders.some((folder) => {
      try {
        accessSync(folder ? join(folder, binary) : binary, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  },
  loggedIn(profile) {
    return checkLogin(profile, run);
  },
  herdrVersion,
  sessionRunning,
  now: () => new Date(),
  home: homedir(),
};

export const USAGE = 'Usage: team doctor [--session <name>] [--file <path>] [--login]\n';

export type Level = 'ok' | 'warn' | 'miss' | 'note';
export type Finding = { level: Level; text: string };

// A missing or stale watch is not a reason for `up` to refuse: `up` starts the watch itself.
export function blocksLaunch(finding: Finding): boolean {
  if (finding.level !== 'miss') return false;
  return !finding.text.startsWith('no watch has run') && !finding.text.startsWith("the watch's heartbeat");
}

export const doctor: Command = (argv, io) => runDoctor(argv, io, realSources);
export default doctor;

function range(tested: { from: string; to: string }): string {
  return tested.from === tested.to ? tested.from : `${tested.from} to ${tested.to}`;
}

function versionFinding(name: string, printed: string, tested: { from: string; to: string }): Finding {
  const verdict = versionVerdict(printed, tested);
  if (verdict === 'tested') return { level: 'ok', text: `${name} ${printed}` };
  if (verdict === 'unread') return { level: 'warn', text: `${name}: its version can't be read from "${printed}"` };
  return { level: 'warn', text: `${name} ${printed} is ${verdict} than the tested ${range(tested)}` };
}

// The command a launch line starts: its first word that is not a variable assignment.
function launchBinary(launch: string): string | null {
  return (
    launch
      .trim()
      .split(/\s+/)
      .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? null
  );
}

function checkFindings(team: TeamFile, root: string, home: string): Finding[] {
  const record = readApproval(storePath(team.project, root, home));
  if (!record) return [];
  return checkReadings(budgetsInForce(team, root, home), record.approval.checks).flatMap((reading) =>
    reading.state === 'unknown'
      ? [{ level: 'warn' as const, text: `the check for ${reading.account} is unapproved; that account reads unknown` }]
      : [],
  );
}

function approvalFindings(team: TeamFile, root: string, home: string): Finding[] {
  const differences = approvalDifferences(team, root, home);
  if (differences === null) {
    return [{ level: 'miss', text: 'run `team approve`: this file was never approved on this machine' }];
  }
  if (differences.length) return [{ level: 'miss', text: `run \`team approve\`: ${differences.join('; ')}` }];
  return [{ level: 'ok', text: 'the file is the one the owner approved' }];
}

function cliFindings(cli: string, seats: Seat[], sources: DoctorSources): Finding[] {
  const names = seats.map((seat) => seat.name).join(', ');
  const profile = profileFor(cli);
  if (!profile) {
    return [{ level: 'warn', text: `${cli}: no launch profile in this version; \`up\` leaves out ${names}` }];
  }
  const printed = sources.version(profile.binary);
  if (printed === null) {
    return [{ level: 'miss', text: `install \`${profile.binary}\`: it is not on the PATH (${cli}: ${names})` }];
  }
  const findings = [versionFinding(profile.binary, printed, profile.tested)];
  const loggedIn = sources.loggedIn(profile);
  if (loggedIn === false) findings.push({ level: 'miss', text: `log in to ${cli}: \`${profile.loginHint}\`` });
  else if (loggedIn === null)
    findings.push({ level: 'note', text: `${cli}: the login is not checked in this version` });
  else findings.push({ level: 'ok', text: `${cli}: logged in` });

  for (const seat of seats) {
    const binary = launchBinary(seat.launch);
    if (binary !== null && binary !== profile.binary && !sources.onPath(binary)) {
      findings.push({ level: 'miss', text: `${seat.name}: its launcher \`${binary}\` is not on the PATH` });
    }
    const named = profile.modelOf(seat.launch);
    if (named === null) {
      findings.push({
        level: 'warn',
        text: `${seat.name}: the launch names no model this version knows; the file says ${seat.model} ${seat.version}`,
      });
    } else if (named.model !== seat.model || named.version !== seat.version) {
      findings.push({
        level: 'warn',
        text: `${seat.name}: the launch starts ${named.model} ${named.version}, the file says ${seat.model} ${seat.version}`,
      });
    }
  }
  return findings;
}

// `watch` is the watch values in force — the approved ones — so an unapproved interval edit can't
// move the verdict either way.
function watchFindings(watch: TeamFile['watch'], dir: string, session: string, running: boolean | null, now: Date): Finding[] {
  const recorded = readState(dir).sessions[session]?.watch;
  if (!running) return [];
  if (!recorded) return [{ level: 'miss', text: `no watch has run for session ${session}: start \`team watch\`` }];
  const age = (now.getTime() - Date.parse(recorded.heartbeat)) / 1000;
  if (!(age <= 2 * watch.interval)) {
    return [
      {
        level: 'miss',
        text: `the watch's heartbeat is ${Math.round(age / 60)} min old (two intervals are ${(2 * watch.interval) / 60} min): start \`team watch\``,
      },
    ];
  }
  return [{ level: 'ok', text: 'the watch is running' }];
}

export function doctorFindings(
  team: TeamFile,
  root: string,
  dir: string,
  session: string,
  sources: DoctorSources,
  warnings: { line: number; message: string }[],
  /** The file as approved. `add` hands the team about to run, whose `stopped` mark is already cleared. */
  approved: TeamFile = team,
): Finding[] {
  const findings: Finding[] = warnings.map((warning) => ({
    level: 'warn',
    text: `the file, line ${warning.line}: ${warning.message}`,
  }));

  findings.push(...approvalFindings(approved, root, sources.home), ...checkFindings(team, root, sources.home));

  const herdr = sources.herdrVersion();
  const running = herdr === null ? null : sources.sessionRunning(session);
  if (herdr === null) findings.push({ level: 'miss', text: 'install herdr: it is not on the PATH' });
  else {
    findings.push(versionFinding('herdr', herdr, HERDR_TESTED));
    if (running === null) findings.push({ level: 'miss', text: "herdr doesn't answer" });
    else findings.push({ level: 'note', text: `session ${session} is ${running ? 'running' : 'not running'}` });
  }

  const launched = team.seats.filter((seat) => !seat.stopped);
  for (const cli of new Set(launched.map((seat) => seat.cli))) {
    findings.push(
      ...cliFindings(
        cli,
        launched.filter((seat) => seat.cli === cli),
        sources,
      ),
    );
  }

  findings.push(...watchFindings(watchInForce(team, root, sources.home), dir, session, running, sources.now()));
  if (team.trust.length) {
    findings.push({ level: 'note', text: 'trust: not applied or checked by this version; trust each folder by hand' });
  }
  return findings;
}

export function doctorLoginFindings(team: TeamFile, sources: DoctorSources): Finding[] {
  const clis: string[] = [];
  for (const seat of team.seats) {
    if (!clis.includes(seat.cli)) clis.push(seat.cli);
  }
  const findings: Finding[] = [];
  for (const cli of clis) {
    const profile = profileFor(cli);
    if (!profile) {
      findings.push({ level: 'note', text: `${cli}: no launch profile in this version` });
      continue;
    }
    const loggedIn = sources.loggedIn(profile);
    if (loggedIn === false) {
      findings.push({ level: 'miss', text: `log in to ${cli}: \`${profile.loginHint}\`` });
    } else if (loggedIn === null) {
      findings.push({ level: 'note', text: `${cli}: the login is not checked in this version` });
    } else {
      findings.push({ level: 'ok', text: `${cli}: logged in` });
    }
  }
  return findings;
}

export async function runDoctor(argv: string[], io: Io, sources: DoctorSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['login']);
  if (args.error || args.rest.length) {
    io.stderr(`team doctor: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2;
  }
  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team doctor: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  const { team, root } = loaded;
  const session = args.values.session ?? team.session;
  const findings = args.flags.has('login')
    ? doctorLoginFindings(team, sources)
    : doctorFindings(team, root, dirname(loaded.path), session, sources, loaded.warnings);

  const label: Record<Level, string> = { ok: 'ok  ', warn: 'warn', miss: 'MISS', note: '--  ' };
  io.stdout(findings.map((finding) => `${label[finding.level]}  ${finding.text}\n`).join(''));
  const missing = findings.filter((finding) => finding.level === 'miss').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  io.stdout(
    missing
      ? `team doctor: ${missing} missing, ${warnings} warning${warnings === 1 ? '' : 's'}: \`up\` and \`add\` refuse until the missing ones are done\n`
      : `team doctor: nothing missing, ${warnings} warning${warnings === 1 ? '' : 's'}\n`,
  );
  return missing ? 1 : 0;
}
