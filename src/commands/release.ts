import { readArgs } from '../args.ts';
import { loadTeamFile } from '../file/load.ts';
import { SEMVER_PATTERN, packageProblem } from '../release/grammar.ts';
import { runChecks, type ReleaseResult, type Status } from '../release/checks.ts';
import { realFetch, type Fetch } from '../release/http.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = `Usage: team release check <package@version> [--json]

  <package@version>   a package of the file's releases, and its SemVer version
  --json              print the result as one JSON object

Checks the public npm and GitHub records of one release: the exact version and
its checksums (with provenance when the file declares trusted publishing), the
tag, the release, and the changelog entry. Read-only and credential-free.

Exits 0 when every check passes, 1 when one is missing, 2 when one is unknown,
64 on a bad invocation or an invalid team file.
`;

const ORDER = ['npm', 'tag', 'github', 'changelog'] as const;

const release: Command = (argv, io) => runRelease(argv, io, realFetch);
export default release;

export async function runRelease(argv: string[], io: Io, fetcher: Fetch): Promise<number> {
  // All arguments are read before deciding how to report: `--json` decides the shape of even an
  // argument error, wherever it appears — including after an unknown option, which readArgs
  // reports before ever reaching the flag.
  const json = argv.includes('--json');
  const args = readArgs(argv, [], ['json']);
  const sub = args.rest[0];
  const fail = (code: 'usage' | 'configuration', message: string): number => {
    if (json) io.stdout(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.stderr(`team release: ${message}\n`);
    return 64;
  };

  // The arguments are validated first, without reading the team file: an invalid argument is a
  // usage error even when the file is invalid.
  if (args.error) return fail('usage', args.error);
  if (sub !== 'check') return fail('usage', sub === undefined ? 'a subcommand is required: check' : `unknown subcommand ${JSON.stringify(sub)}`);
  const target = args.rest[1];
  if (target === undefined) return fail('usage', 'a <package@version> is required');
  if (args.rest.length > 2) return fail('usage', `unexpected ${JSON.stringify(args.rest[2])}`);
  const at = target.lastIndexOf('@');
  const name = at > 0 ? target.slice(0, at) : '';
  const version = at > 0 ? target.slice(at + 1) : '';
  if (name === '' || version === '') return fail('usage', `${JSON.stringify(target)} is not <package>@<version>`);
  const named = packageProblem(name);
  if (named !== null) return fail('usage', `the package ${JSON.stringify(name)} ${named}`);
  if (!SEMVER_PATTERN.test(version)) return fail('usage', `the version ${JSON.stringify(version)} is not a Semantic Versioning 2.0.0 version`);

  // Only with valid arguments is the file read; an invalid file is the configuration error.
  const loaded = loadTeamFile(io.cwd, {});
  if (!loaded.ok) {
    const first = loaded.errors[0] as { line: number; message: string };
    const where = [loaded.path, first.line > 0 ? `line ${first.line}` : ''].filter(Boolean).join(', ');
    return fail('configuration', `${where === '' ? '' : `${where}: `}${first.message}`);
  }
  // And only with a valid file is the package looked up: undeclared is the configuration-dependent
  // usage error.
  const decl = loaded.team.releases.find((entry) => entry.package === name);
  if (!decl) return fail('usage', `${name} is not declared in the team file's releases`);

  const result = await runChecks(decl, version, fetcher);
  if (json) {
    io.stdout(jsonResult(name, version, result));
  } else {
    io.stdout(table(result));
  }
  const statuses = ORDER.map((check) => result[check].status);
  if (statuses.every((status) => status === 'pass')) return 0;
  return statuses.includes('unknown') ? 2 : 1;
}

// One JSON object and nothing else: the three keys in order, each check on one line.
function jsonResult(name: string, version: string, result: ReleaseResult): string {
  const lines = ORDER.map((check) => {
    const { status, detail } = result[check];
    return `    ${JSON.stringify(check)}: { "status": ${JSON.stringify(status)}, "detail": ${JSON.stringify(detail)} }`;
  });
  return `{\n  "package": ${JSON.stringify(name)},\n  "version": ${JSON.stringify(version)},\n  "checks": {\n${lines.join(',\n')}\n  }\n}\n`;
}

function table(result: ReleaseResult): string {
  const rows: string[][] = [
    ['check', 'status', 'detail'],
    ...ORDER.map((check) => [check, result[check].status as Status, result[check].detail]),
  ];
  const first = Math.max(...rows.map((row) => (row[0] as string).length));
  const second = Math.max(...rows.map((row) => (row[1] as string).length));
  return `${rows.map((row) => `${(row[0] as string).padEnd(first)}  ${(row[1] as string).padEnd(second)}  ${row[2]}`).join('\n')}\n`;
}
