import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CheckConfig } from '../check/config.ts'
import { GitError } from '../check/git.ts'
import { formatReport, runCheck } from '../check/run.ts'

// Replaced by the foundation's `Io` and loader when it lands.
export interface Io {
  stdout(text: string): void
  stderr(text: string): void
  cwd: string
}

export type LoadConfig = (
  cwd: string,
  file?: string,
) => { ok: true; config: CheckConfig } | { ok: false; errors: { line: number; message: string }[]; path?: string }

export const USAGE = `usage: team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --pr <file>      also check a pull request's body ("-" reads standard input)
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    the team file, instead of .agents/team.yaml

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
`

interface Arguments {
  ref: string
  pr?: string
  since?: string
  file?: string
}

const VALUE_OPTIONS = ['pr', 'since', 'file'] as const

function parse(argv: string[]): Arguments | string {
  const values: Partial<Record<(typeof VALUE_OPTIONS)[number], string>> = {}
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2)
    const option = VALUE_OPTIONS.find((known) => known === name)
    if (!option) return `unknown option ${argument}`
    const value = inline ?? argv[++index]
    if (value === undefined || value === '') return `--${option} needs a value`
    values[option] = value
  }
  if (positional.length !== 1) return positional.length === 0 ? 'a <ref> is required' : 'one <ref> at most'
  return { ref: positional[0], ...values }
}

const notWired: LoadConfig = () => ({ ok: false, errors: [{ line: 0, message: 'the team file loader is not built yet' }] })

export async function check(argv: string[], io: Io, load: LoadConfig = notWired): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(USAGE)
    return 0
  }
  const args = parse(argv)
  if (typeof args === 'string') {
    io.stderr(`team check: ${args}\n\n${USAGE}`)
    return 2
  }

  const loaded = load(io.cwd, args.file)
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      const where = [loaded.path, problem.line > 0 ? `line ${problem.line}` : ''].filter(Boolean).join(', ')
      io.stderr(`team check: ${where ? `${where}: ` : ''}${problem.message}\n`)
    }
    return 2
  }

  let pullRequestBody: string | undefined
  if (args.pr !== undefined) {
    try {
      pullRequestBody = readFileSync(args.pr === '-' ? 0 : resolve(io.cwd, args.pr), 'utf8')
    } catch (error) {
      io.stderr(`team check: can't read the pull request body: ${(error as Error).message}\n`)
      return 2
    }
  }

  try {
    const report = runCheck(loaded.config, { cwd: io.cwd, ref: args.ref, since: args.since, pullRequestBody })
    io.stdout(formatReport(report))
    return report.ok ? 0 : 1
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    io.stderr(`team check: ${error.message}\n`)
    return 2
  }
}

export default check
