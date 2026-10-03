import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { approvalDifferences } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { loadTeamFile } from '../file/load.ts';
import { renderSignature } from '../file/signature.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { agentList, sessionRunning, type HerdrAgent } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { formatPlan, upPlan } from '../launch/plan.ts';
import { rulesText } from '../launch/rules.ts';
import { readState } from '../state.ts';

// What `up` reads from outside the file, so tests can stand in for it.
export type UpSources = {
  sessionRunning(session: string): boolean | null;
  agents(session: string): HerdrAgent[] | null;
  home: string;
};

export const realSources: UpSources = {
  sessionRunning,
  agents: (session) => agentList(session === 'default' ? undefined : session),
  home: homedir(),
};

const USAGE = 'Usage: team up --dry-run [--session <name>] [--file <path>]\n';

export const up: Command = (argv, io) => runUp(argv, io, realSources);
export default up;

/** The rules one seat gets at launch, with its own signature lines. */
export function rulesOf(team: TeamFile, seat: Seat): string {
  const { commits, pullRequests } = team.identity.signature;
  return rulesText({
    coordinator: team.coordinator,
    rules: team.rules,
    signature: {
      commit: renderSignature(commits.template, seat),
      pullRequest: renderSignature(pullRequests.template, seat),
      commitPosition: commits.position,
    },
    workspace: { mode: seat.mode, protected: team.workspace.protected, branch: team.workspace.branch },
  });
}

export async function runUp(argv: string[], io: Io, sources: UpSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['dry-run']);
  if (args.error || args.rest.length) {
    io.stderr(`team up: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2;
  }
  if (!args.flags.has('dry-run')) {
    io.stderr(`team up: this version launches nothing; \`--dry-run\` prints every command it would run\n${USAGE}`);
    return 1;
  }
  const loaded = loadTeamFile(io.cwd, args.values.file ? { file: args.values.file } : {});
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team up: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 2;
  }
  const { team, root } = loaded;
  const session = args.values.session ?? team.session;

  // What would make `up` refuse, read the same way it will read it. A dry run prints the plan anyway.
  const refusals: string[] = [];
  const caller = callerOf(io);
  if (!isOwner(caller)) {
    refusals.push(`only the owner runs \`up\`, from a terminal outside herdr; this call is ${describeCaller(caller)}`);
  }
  const differences = approvalDifferences(team, root, sources.home);
  if (differences === null) refusals.push('the file was never approved on this machine: run `team approve`');
  else if (differences.length)
    refusals.push(`the file is not the approved one (${differences.join('; ')}): run \`team approve\``);

  const running = sources.sessionRunning(session);
  if (running === null) refusals.push("herdr doesn't answer");
  if (running) {
    const recorded = readState(dirname(loaded.path)).sessions[session]?.seats ?? {};
    const agents = sources.agents(session);
    if (agents === null) refusals.push(`session ${session} runs, and its agents can't be read`);
    else {
      const unknown = agents.filter((agent) => !agent.name || !Object.hasOwn(recorded, agent.name));
      if (unknown.length) {
        refusals.push(
          `session ${session} has ${unknown.length} agent${unknown.length === 1 ? '' : 's'} this file's state doesn't record: \`up\` never touches a running team`,
        );
      }
    }
  }

  for (const refusal of refusals) io.stdout(`! up would refuse: ${refusal}\n`);
  io.stdout(
    formatPlan(
      upPlan({
        root,
        session,
        sessionRunning: running === true,
        seats: team.seats.map((seat) => ({
          name: seat.name,
          cli: seat.cli,
          launch: seat.launch,
          cwd: seat.cwd,
          label: seat.label,
          stopped: seat.stopped,
          rules: rulesOf(team, seat),
        })),
      }),
    ),
  );
  return 0;
}
