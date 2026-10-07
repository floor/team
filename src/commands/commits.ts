// `team commits check <ref>`: today's commit half of `team check`, under its own name. The body
// half lives in `commands/pr.ts`, and the old spelling lives on as the `team check` alias
// (`commands/check.ts`), which reaches this file's `runCommits` so both spellings run one code
// path. Read only: it reads a repository, a file and a body, and writes nothing.
import { GitError } from '../check/git.ts';
import { loadConfig, place, type LoadConfig } from '../check/load.ts';
import { formatReport, runCheck } from '../check/run.ts';
import type { Command, Io } from '../io.ts';
import { bodyRefused, bodyText } from './pr.ts';

export const USAGE = `Usage: team commits check <ref> [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    the team file, instead of .agents/team.yaml

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
`;

interface Arguments {
  ref: string;
  since?: string;
  file?: string;
}

const VALUE_OPTIONS = ['since', 'file'] as const;

function parse(argv: string[]): Arguments | string {
  const values: Partial<Record<(typeof VALUE_OPTIONS)[number], string>> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) {
      rest.push(argument);
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const option = VALUE_OPTIONS.find((known) => known === name);
    if (!option) return `unknown option ${argument}`;
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') return `--${option} needs a value`;
    values[option] = value;
  }
  const args = { values, rest };
  const sub = args.rest[0];
  if (sub !== 'check') return sub === undefined ? 'a subcommand is required: check' : `unknown subcommand ${JSON.stringify(sub)}`;
  const ref = args.rest[1];
  if (ref === undefined) return 'a <ref> is required';
  if (args.rest.length > 2) return 'one <ref> at most';
  return { ref, ...args.values };
}

/** What a run needs after the arguments are read. `pr` is the path as typed, not its text: the
 *  read happens inside `runCommits`, after the file is loaded, so the old spelling of
 *  `team check --pr` refuses in the order it always has, and its one refusal site lives in
 *  `commands/pr.ts` (`pr.body`). */
export type CommitsRun = {
  ref: string;
  since?: string;
  file?: string;
  pr?: string;
};

/** The commit half's one run, shared by `team commits check` and the `team check` alias. */
export async function runCommits(io: Io, load: LoadConfig, options: CommitsRun): Promise<number> {
  const loaded = load(io.cwd, options.file);
  if (!loaded.ok) {
    for (const problem of loaded.errors) io.stderr(`team commits check: ${place(problem, loaded.path)}\n`);
    // exit: commits.not-a-repo
    // exit: commits.file
    // exit: commits.file-invalid
    // exit: commits.ledger
    return 2;
  }

  for (const warning of loaded.warnings) io.stderr(`team commits check: warning: ${place(warning)}\n`);

  let pullRequestBody: string | undefined;
  if (options.pr !== undefined) {
    try {
      pullRequestBody = bodyText(options.pr, io.cwd);
    } catch (error) {
      return bodyRefused(io, error);
    }
  }

  try {
    const report = runCheck(loaded.config, { cwd: io.cwd, ref: options.ref, since: options.since, pullRequestBody });
    io.stdout(formatReport(report));
    // exit: commits.passed
    // exit: commits.refused
    return report.ok ? 0 : 1;
  } catch (error) {
    // exit: commits.threw
    if (!(error instanceof GitError)) throw error;
    io.stderr(`team commits check: ${error.message}\n`);
    // exit: commits.outside
    // exit: commits.no-commit
    // exit: commits.range
    // exit: commits.empty-range
    // exit: commits.since-missing
    // exit: commits.since-unreachable
    // exit: commits.not-a-ref
    return 2;
  }
}

export async function commits(argv: string[], io: Io, load: LoadConfig = loadConfig): Promise<number> {
  const args = parse(argv);
  if (typeof args === 'string') {
    io.stderr(`team commits check: ${args}\n\n${USAGE}`);
    // exit: commits.invocation
    return 2;
  }
  return runCommits(io, load, args);
}

const command: Command = (argv, io) => commits(argv, io);
export default command;
