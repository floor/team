import { forbiddenPatterns, type CheckConfig } from './config.ts';
import { selectCommits, type Commit } from './git.ts';
import { checkSignature, findForbidden, splitLines, type Finding } from './message.ts';

export interface CheckOptions {
  /** A folder of the repository to read. */
  cwd: string;
  /** A range when it holds `..`, else one commit. */
  ref: string;
  /** Overrides the file's `identity.since` for this run. */
  since?: string;
  /** A pull request's body, to check as well. */
  pullRequestBody?: string;
}

export interface CommitReport {
  hash: string;
  subject: string;
  /** Why the commit needs no signature; its forbidden patterns are still checked. */
  exempt?: 'merge' | 'human';
  findings: Finding[];
}

export interface CheckReport {
  commits: CommitReport[];
  skipped: number;
  since?: string;
  /** Present when a PR body was checked. */
  pullRequest?: Finding[];
  ok: boolean;
}

function exemption(commit: Commit, config: CheckConfig, humans: Set<string>): CommitReport['exempt'] {
  if (config.commits.exemptMerge && commit.parents.length > 1) return 'merge';
  if (humans.has(commit.authorEmail.toLowerCase())) return 'human';
  return undefined;
}

/** Checks the commits of `ref`, and a PR body when one is given. Read only. */
export function runCheck(config: CheckConfig, options: CheckOptions): CheckReport {
  const patterns = forbiddenPatterns(config);
  const humans = new Set(config.humans.map((email) => email.toLowerCase()));
  const selection = selectCommits(options.cwd, options.ref, options.since ?? config.since);

  const commits = selection.commits.map((commit): CommitReport => {
    const lines = splitLines(commit.message);
    const exempt = exemption(commit, config, humans);
    const findings = findForbidden(lines, patterns);
    if (!exempt) {
      findings.push(
        ...checkSignature({ lines, rule: config.commits, ledger: config.ledger, trailers: commit.trailers }),
      );
    }
    return { hash: commit.hash, subject: commit.subject, exempt, findings };
  });

  const pullRequest = options.pullRequestBody === undefined ? undefined : checkBody(config, options.pullRequestBody);

  const ok = commits.every((commit) => commit.findings.length === 0) && (pullRequest?.length ?? 0) === 0;
  return { commits, skipped: selection.skipped, since: selection.since, pullRequest, ok };
}

/** One pull request body's findings: the file's forbidden patterns, and the signature rule the
 *  file writes for bodies (`pullRequests`). Pure over the config and the text, so the commit run
 *  and the body-only `team pr check` share one definition of what a body must pass. */
export function checkBody(config: CheckConfig, body: string): Finding[] {
  const lines = splitLines(body);
  return [
    ...findForbidden(lines, forbiddenPatterns(config)),
    ...checkSignature({ lines, rule: config.pullRequests, ledger: config.ledger }),
  ];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function findingLines(finding: Finding): string[] {
  const where = finding.line === undefined ? '' : `line ${finding.line}: `;
  const lines = [`  ${where}${finding.message}`];
  if (finding.text !== undefined) lines.push(`    ${finding.text}`);
  return lines;
}

/** The report as `team commits check` prints it: each offending commit and line, then a summary. */
export function formatReport(report: CheckReport): string {
  const out: string[] = [];
  for (const commit of report.commits) {
    if (commit.findings.length === 0) continue;
    out.push(`${commit.hash.slice(0, 10)} ${commit.subject}`);
    for (const finding of commit.findings) out.push(...findingLines(finding));
  }
  if (report.pullRequest && report.pullRequest.length > 0) {
    out.push('pull request body');
    for (const finding of report.pullRequest) out.push(...findingLines(finding));
  }

  const failed = report.commits.filter((commit) => commit.findings.length > 0).length;
  const exempt = report.commits.filter((commit) => commit.exempt).length;
  const parts = [`${plural(report.commits.length, 'commit')} checked`];
  if (exempt > 0) parts.push(`${exempt} by a human or a merge`);
  if (report.skipped > 0) parts.push(`${report.skipped} skipped (since ${report.since?.slice(0, 10)})`);
  if (report.pullRequest) parts.push('1 pull request body checked');
  const problems: string[] = [];
  if (failed > 0) problems.push(`${plural(failed, 'commit')} refused`);
  if (report.pullRequest && report.pullRequest.length > 0) problems.push('the pull request body refused');
  out.push(`team commits check: ${parts.join(', ')}: ${report.ok ? 'ok' : problems.join(', ')}`);
  return `${out.join('\n')}\n`;
}

/** The report as `team pr check` prints it: the body's section and findings, then the closing
 *  line — the same parts `formatReport` prints for a body alone (design note §2.2). */
export function formatBodyReport(findings: readonly Finding[]): string {
  const out: string[] = [];
  if (findings.length > 0) {
    out.push('pull request body');
    for (const finding of findings) out.push(...findingLines(finding));
  }
  out.push(`team pr check: 1 pull request body checked: ${findings.length === 0 ? 'ok' : 'the pull request body refused'}`);
  return `${out.join('\n')}\n`;
}
