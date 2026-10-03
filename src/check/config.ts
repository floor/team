/**
 * What `check` needs from a validated team file: the `identity` section with
 * its defaults applied, and the seats whose signatures are accepted.
 */

export type Position = 'last-line' | 'trailer' | 'anywhere'

/** One `display` and `role` the team has had, with the fields a template may use. */
export interface SeatIdentity {
  display: string
  role: string
  model: string
  version: string
}

export interface SignatureRule {
  template: string
  position: Position
}

export interface CheckConfig {
  /** Whether `forbiddenPublic` applies. */
  public: boolean
  commits: SignatureRule & { exemptMerge: boolean }
  pullRequests: SignatureRule
  /** Author emails whose commits need no signature. */
  humans: string[]
  /** A commit: it and everything reachable from it are skipped. */
  since?: string
  /** The file's patterns; the defaults are added by `forbiddenPatterns`. */
  forbidden: string[]
  forbiddenPublic: string[]
  /** Every seat whose signature is accepted. */
  ledger: SeatIdentity[]
}

/** Patterns no commit message or PR body may contain, whatever the file says. */
export const DEFAULT_FORBIDDEN: readonly string[] = [
  '^Claude-Session:',
  'https?://claude\\.ai/code/session',
]

export interface ForbiddenPattern {
  source: string
  regex: RegExp
}

/**
 * The patterns that apply to this project: the defaults, the file's, and the
 * public ones when the project is public. Throws on a pattern that isn't a
 * regular expression.
 */
export function forbiddenPatterns(config: CheckConfig): ForbiddenPattern[] {
  const sources = [
    ...DEFAULT_FORBIDDEN,
    ...config.forbidden,
    ...(config.public ? config.forbiddenPublic : []),
  ]
  const patterns: ForbiddenPattern[] = []
  for (const source of new Set(sources)) {
    let regex: RegExp
    try {
      regex = new RegExp(source)
    } catch (error) {
      throw new Error(
        `forbidden pattern ${JSON.stringify(source)} is not a regular expression: ${(error as Error).message}`,
      )
    }
    patterns.push({ source, regex })
  }
  return patterns
}
