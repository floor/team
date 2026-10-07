// The old spelling of `team commits check` and `team pr check`, still read through 0.3.3 (design
// note §2.3). The parse rule: a `team check` with no argument at all is the new team check —
// reserved, and not built in this slice — so it refuses here exactly as it always has (`a <ref>
// is required` and the usage, exit 2) and never runs the old form. Any argument is the old
// spelling: one notice line per half on stderr, then the shared run (`runCommits`), so the old
// name and the new ones run one code path and print one report.
import { loadConfig, type LoadConfig } from '../check/load.ts';
import type { Io } from '../io.ts';
import { runCommits } from './commits.ts';

export { loadConfig };
export type { LoadConfig };

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

export async function check(argv: string[], io: Io, load: LoadConfig = loadConfig): Promise<number> {
  const args = parse(argv);
  if (typeof args === 'string') {
    // A refused invocation keeps the bytes it always had, and takes no notice: an error already
    // says what to fix, and the bare form — the new team check's own — has nothing to accept yet.
    io.stderr(`team check: ${args}\n\n${USAGE}`);
    // exit: check.invocation
    return 2;
  }
  io.stderr('team check: `team check` is now `team commits check`, and is still read through 0.3.3\n');
  if (args.pr !== undefined) {
    io.stderr('team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3\n');
  }
  return runCommits(io, load, { ref: args.ref, since: args.since, file: args.file, pr: args.pr });
}

export default check;
