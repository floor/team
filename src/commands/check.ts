import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fromTeamFile, type CheckConfig } from '../check/config.ts';
import { GitError } from '../check/git.ts';
import { formatReport, runCheck } from '../check/run.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Problem } from '../file/types.ts';
import type { Io } from '../io.ts';
import { readLedger, storePath } from '../store/store.ts';

export type LoadConfig = (
  cwd: string,
  file?: string,
) => { ok: true; config: CheckConfig; warnings: Problem[] } | { ok: false; errors: Problem[]; path?: string };

export const USAGE = `Usage: team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --pr <file>      also check a pull request's body ("-" reads standard input)
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    the team file, instead of .agents/team.yaml

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
`;

interface Arguments {
  ref: string;
  pr?: string;
  since?: string;
  file?: string;
}

const VALUE_OPTIONS = ['pr', 'since', 'file'] as const;

function parse(argv: string[]): Arguments | string {
  const values: Partial<Record<(typeof VALUE_OPTIONS)[number], string>> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const option = VALUE_OPTIONS.find((known) => known === name);
    if (!option) return `unknown option ${argument}`;
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') return `--${option} needs a value`;
    values[option] = value;
  }
  const [ref, ...rest] = positional;
  if (ref === undefined) return 'a <ref> is required';
  if (rest.length > 0) return 'one <ref> at most';
  return { ref, ...values };
}

/** The file's rules, with the ledger of this machine's store when the owner has approved a file here. */
export function loadConfig(cwd: string, file?: string, home: string = homedir()): ReturnType<LoadConfig> {
  const loaded = loadTeamFile(cwd, { file });
  if (!loaded.ok) return loaded;
  const store = storePath(loaded.team.project, loaded.root, home);
  const ledgerFile = join(store, 'ledger.json');
  try {
    const ledger = readLedger(store);
    return { ok: true, config: fromTeamFile(loaded.team, ledger), warnings: loaded.warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ line: 0, message: `can't read ${ledgerFile}: ${detail}` }] };
  }
}

function place(problem: Problem, path?: string): string {
  const where = [path, problem.line > 0 ? `line ${problem.line}` : ''].filter(Boolean).join(', ');
  return `${where ? `${where}: ` : ''}${problem.message}`;
}

export async function check(argv: string[], io: Io, load: LoadConfig = loadConfig): Promise<number> {
  const args = parse(argv);
  if (typeof args === 'string') {
    io.stderr(`team check: ${args}\n\n${USAGE}`);
    return 2;
  }

  const loaded = load(io.cwd, args.file);
  if (!loaded.ok) {
    for (const problem of loaded.errors) io.stderr(`team check: ${place(problem, loaded.path)}\n`);
    return 2;
  }

  for (const warning of loaded.warnings) io.stderr(`team check: warning: ${place(warning)}\n`);

  let pullRequestBody: string | undefined;
  if (args.pr !== undefined) {
    try {
      pullRequestBody = readFileSync(args.pr === '-' ? 0 : resolve(io.cwd, args.pr), 'utf8');
    } catch (error) {
      io.stderr(`team check: can't read the pull request body: ${(error as Error).message}\n`);
      return 2;
    }
  }

  try {
    const report = runCheck(loaded.config, { cwd: io.cwd, ref: args.ref, since: args.since, pullRequestBody });
    io.stdout(formatReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    io.stderr(`team check: ${error.message}\n`);
    return 2;
  }
}

export default check;
