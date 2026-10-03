/**
 * What `check` needs from a validated team file: the `identity` section with
 * its defaults applied, and the seats whose signatures are accepted.
 */

import { DEFAULT_FORBIDDEN } from '../file/signature.ts';
import type { Position, TeamFile } from '../file/types.ts';

/** One `display` and `role` the team has had, with the fields a template may use. */
export interface SeatIdentity {
  display: string;
  role: string;
  model: string;
  version: string;
}

export interface SignatureRule {
  template: string;
  position: Position;
}

export interface CheckConfig {
  /** Whether `forbiddenPublic` applies. */
  public: boolean;
  commits: SignatureRule & { exemptMerge: boolean };
  pullRequests: SignatureRule;
  /** Author emails whose commits need no signature. */
  humans: string[];
  /** A commit: it and everything reachable from it are skipped. */
  since?: string;
  /** The file's patterns; the defaults are added by `forbiddenPatterns`. */
  forbidden: string[];
  forbiddenPublic: string[];
  /** Every seat whose signature is accepted. */
  ledger: SeatIdentity[];
}

/**
 * What `check` reads of a validated file. Until `approve` brings the ledger,
 * the accepted signatures are those of the file's seats.
 */
export function fromTeamFile(team: TeamFile): CheckConfig {
  const { identity } = team;
  return {
    public: team.visibility === 'public',
    commits: {
      template: identity.signature.commits.template,
      position: identity.signature.commits.position,
      exemptMerge: identity.signature.commits.exempt.includes('merge'),
    },
    pullRequests: identity.signature.pullRequests,
    humans: identity.humans,
    since: identity.since ?? undefined,
    forbidden: identity.forbidden,
    forbiddenPublic: identity.forbiddenPublic,
    ledger: team.seats.map(({ display, role, model, version }) => ({ display, role, model, version })),
  };
}

export interface ForbiddenPattern {
  source: string;
  regex: RegExp;
}

/**
 * The patterns that apply to this project: the defaults (a validated file
 * already lists them; they are never left out), the file's, and the public
 * ones when the project is public. Throws on a pattern that isn't a
 * regular expression.
 */
export function forbiddenPatterns(config: CheckConfig): ForbiddenPattern[] {
  const sources = [...DEFAULT_FORBIDDEN, ...config.forbidden, ...(config.public ? config.forbiddenPublic : [])];
  const patterns: ForbiddenPattern[] = [];
  for (const source of new Set(sources)) {
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (error) {
      throw new Error(
        `forbidden pattern ${JSON.stringify(source)} is not a regular expression: ${(error as Error).message}`,
      );
    }
    patterns.push({ source, regex });
  }
  return patterns;
}
