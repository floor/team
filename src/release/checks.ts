// The four checks of `team release check`, against the public npm and GitHub records of one
// release. Every check reports pass, missing or unknown: missing is a completed, interpretable
// read that disproves the condition; unknown is a failed, incomplete, malformed or unexpected
// read, and unknown is never pass. A compound check makes every required read its known upstream
// results can still form — it does not short-circuit after a missing condition — and combines
// them unknown, then missing, then pass. A read an upstream missing makes unformable is not
// required and is not requested; one an upstream unknown makes unformable is unknown.
import { hasPrerelease } from './grammar.ts';
import type { Attempt, Fetch, RequestOptions } from './http.ts';
import type { KeyReader } from './keychain.ts';
import type { ReleaseDecl } from '../file/sections/releases.ts';

export type Status = 'pass' | 'missing' | 'unknown';
export type Outcome = { status: Status; detail: string };
export type ReleaseResult = {
  npm: Outcome;
  tag: Outcome;
  github: Outcome;
  changelog: Outcome;
  /** Present exactly when the file configures the pair. */
  linear?: Outcome;
  activity?: Outcome;
};

/** One command's budget: at most thirteen endpoint reads and twenty-six HTTP attempts, retries included. */
export const READ_CAP = 13;
export const ATTEMPT_CAP = 26;

export type Caps = { reads: number; attempts: number };

/** What one run is wired with beyond the network: the Keychain reader, and caps for tests. */
export type CheckDeps = { keyReader?: KeyReader; caps?: Caps };

const PROVENANCE = 'https://slsa.dev/provenance/v1';

/** One RFC 3986 path segment or query value: unreserved characters, uppercase %HH for the rest. */
export function encodeSegment(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9._~-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

type Reply = { kind: 'http'; status: number; body: string } | { kind: 'failed' };

function replyOf(attempt: Attempt | null): Reply {
  return attempt !== null && attempt.kind === 'http' ? attempt : { kind: 'failed' };
}

/** The reads of one command, with the retry policy and the two caps. */
export class Reader {
  reads = 0;
  attempts = 0;
  private fetcher: Fetch;
  private caps: Caps;
  constructor(fetcher: Fetch, caps: Caps = { reads: READ_CAP, attempts: ATTEMPT_CAP }) {
    this.fetcher = fetcher;
    this.caps = caps;
  }

  /** One endpoint read: an HTTP response, or a failure after its one allowed retry. */
  async read(url: string): Promise<Reply> {
    // A read that would exceed its cap is not made; the check needing it reads unknown.
    if (this.reads >= this.caps.reads) return { kind: 'failed' };
    this.reads++;
    const first = await this.attempt(url);
    if (first === null) return { kind: 'failed' };
    if (!retried(first)) return replyOf(first);
    return replyOf(await this.attempt(url));
  }

  private async attempt(url: string): Promise<Attempt | null> {
    if (this.attempts >= this.caps.attempts) return null;
    this.attempts++;
    return this.fetcher(url);
  }
}

// A timeout, a transport failure, or a 408, 429 or 5xx is retried exactly once; nothing else is.
// Every kind that comes from a response carries its status, so the decision reads only that
// status and the two no-response kinds — whatever the body could or could not be decoded into.
export function retried(attempt: Attempt): boolean {
  if (attempt.kind === 'timeout' || attempt.kind === 'transport') return true;
  const { status } = attempt;
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

type ReadRecord =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'json'; value: Record<string, unknown> };

// A reply as the record a check reads: a 404 is missing; a success with a JSON object is the
// record; anything else — another status, a redirect, invalid JSON, a failed or capped read —
// is unknown.
function recordOf(reply: Reply): ReadRecord {
  if (reply.kind !== 'http') return { kind: 'unknown' };
  if (reply.status === 404) return { kind: 'missing' };
  if (reply.status < 200 || reply.status > 299) return { kind: 'unknown' };
  const value = jsonObject(reply.body);
  return value ? { kind: 'json', value } : { kind: 'unknown' };
}

function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Unknown when any part is unknown, else missing when any is missing, else pass. */
function combine(parts: Outcome[], passDetail: string): Outcome {
  for (const part of parts) if (part.status === 'unknown') return part;
  for (const part of parts) if (part.status === 'missing') return part;
  return { status: 'pass', detail: passDetail };
}

const pass: Outcome = { status: 'pass', detail: '' };

/** The repository read the tag and changelog checks share: the default branch. */
type Repo = { kind: 'missing'; detail: string } | { kind: 'unknown'; detail: string } | { kind: 'ok'; branch: string };

async function readRepo(reader: Reader, base: string, github: string): Promise<Repo> {
  const record = recordOf(await reader.read(base));
  if (record.kind === 'missing') return { kind: 'missing', detail: `GitHub has no repository ${github}` };
  if (record.kind === 'unknown') return { kind: 'unknown', detail: 'the repository could not be read' };
  const branch = record.value.default_branch;
  if (typeof branch !== 'string' || branch === '') return { kind: 'unknown', detail: 'the repository could not be read' };
  return { kind: 'ok', branch };
}

function npmVersionPart(record: ReadRecord, name: string, version: string): Outcome {
  if (record.kind === 'missing') return { status: 'missing', detail: `npm has no ${name}@${version}` };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the npm record could not be read' };
  const value = record.value;
  if (typeof value.name !== 'string' || typeof value.version !== 'string' || value.name !== name || value.version !== version) {
    return { status: 'unknown', detail: 'the npm record is not for this package and version' };
  }
  const dist = value.dist;
  if (dist === undefined) return { status: 'missing', detail: 'the npm record has no dist' };
  if (!isObject(dist)) return { status: 'unknown', detail: "the npm record's dist is not an object" };
  // Every field is examined before deciding: only an absent or empty checksum is missing, a
  // present non-string one is unknown, and unknown beats missing across the two fields.
  const parts: Outcome[] = [];
  for (const key of ['shasum', 'integrity'] as const) {
    const checksum = dist[key];
    if (checksum === undefined) parts.push({ status: 'missing', detail: `the npm record has no dist.${key}` });
    else if (typeof checksum !== 'string') parts.push({ status: 'unknown', detail: `dist.${key} is not a string` });
    else if (checksum === '') parts.push({ status: 'missing', detail: `the npm record has an empty dist.${key}` });
  }
  for (const part of parts) if (part.status === 'unknown') return part;
  if (parts.length > 0) return parts[0] as Outcome;
  return pass;
}

function attestationPart(record: ReadRecord): Outcome {
  if (record.kind === 'missing') return { status: 'missing', detail: 'npm shows no provenance attestation for this version' };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the attestation response could not be read' };
  const list = record.value.attestations;
  if (!Array.isArray(list)) return { status: 'unknown', detail: 'the attestation response has no attestations list' };
  const proven = list.some((entry) => isObject(entry) && entry.predicateType === PROVENANCE);
  return proven ? pass : { status: 'missing', detail: 'npm shows no provenance attestation for this version' };
}

async function npmCheck(reader: Reader, decl: ReleaseDecl, version: string): Promise<Outcome> {
  const record = recordOf(await reader.read(`https://registry.npmjs.org/${encodeSegment(decl.package)}/${encodeSegment(version)}`));
  const parts = [npmVersionPart(record, decl.package, version)];
  if (decl.trustedPublishing) {
    const attested = recordOf(
      await reader.read(`https://registry.npmjs.org/-/npm/v1/attestations/${encodeSegment(`${decl.package}@${version}`)}`),
    );
    parts.push(attestationPart(attested));
  }
  return combine(parts, decl.trustedPublishing ? 'exact version, checksums, and provenance found' : 'exact version and checksums found');
}

/** A full Git commit SHA: forty lowercase hex characters — what a compare segment is built from. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The `sha` and `type` of a ref or tag object, or null when either is missing or malformed. */
function targetOf(value: Record<string, unknown>): { sha: string; type: string } | null {
  const object = value.object;
  if (!isObject(object) || typeof object.type !== 'string' || typeof object.sha !== 'string' || !SHA_PATTERN.test(object.sha)) {
    return null;
  }
  return { sha: object.sha, type: object.type };
}

async function tagCheck(reader: Reader, base: string, version: string, repo: Repo): Promise<Outcome> {
  const parts: Outcome[] = [];
  let commit: string | null = null;
  const ref = recordOf(await reader.read(`${base}/git/ref/tags/v${encodeSegment(version)}`));
  if (ref.kind === 'missing') {
    parts.push({ status: 'missing', detail: `GitHub has no tag v${version}` });
  } else if (ref.kind === 'unknown') {
    parts.push({ status: 'unknown', detail: 'the tag could not be read' });
  } else {
    const first = targetOf(ref.value);
    if (first === null) {
      parts.push({ status: 'unknown', detail: 'the tag could not be read' });
    } else {
      let target = first;
      let hops = 0;
      let broken: Outcome | null = null;
      // An annotated tag resolves through at most four tag objects; a fifth required hop is unknown.
      while (target.type === 'tag' && broken === null) {
        if (hops === 4) {
          broken = { status: 'unknown', detail: 'the tag chain needs a fifth tag object' };
          break;
        }
        hops++;
        const hop = recordOf(await reader.read(`${base}/git/tags/${encodeSegment(target.sha)}`));
        if (hop.kind === 'missing') broken = { status: 'missing', detail: `GitHub has no tag object ${target.sha}` };
        else if (hop.kind === 'unknown') broken = { status: 'unknown', detail: 'a tag object could not be read' };
        else {
          const next = targetOf(hop.value);
          if (next === null) {
            broken = { status: 'unknown', detail: 'a tag object could not be read' };
          } else {
            target = next;
          }
        }
      }
      if (broken !== null) parts.push(broken);
      else if (target.type !== 'commit') parts.push({ status: 'missing', detail: 'the tag does not resolve to a commit' });
      else {
        commit = target.sha;
        parts.push(pass);
      }
    }
  }
  // The compare is required only when both its inputs are known: a resolved commit and the
  // default branch. Otherwise the repository read alone carries its outcome into the check.
  if (commit !== null && repo.kind === 'ok') {
    const compared = recordOf(await reader.read(`${base}/compare/${encodeSegment(commit)}...${encodeSegment(repo.branch)}`));
    if (compared.kind === 'missing') parts.push({ status: 'missing', detail: 'GitHub has no compare of the tag and the default branch' });
    else if (compared.kind === 'unknown') parts.push({ status: 'unknown', detail: 'the compare could not be read' });
    else {
      const status = compared.value.status;
      if (status === 'identical' || status === 'ahead') parts.push(pass);
      else if (status === 'behind' || status === 'diverged') {
        parts.push({ status: 'missing', detail: 'tag commit is not an ancestor of the default branch' });
      } else {
        parts.push({ status: 'unknown', detail: 'the compare could not be read' });
      }
    }
  }
  if (repo.kind !== 'ok') parts.push({ status: repo.kind, detail: repo.detail });
  return combine(parts, 'tag resolves to a commit on the default branch');
}

async function githubCheck(reader: Reader, base: string, version: string): Promise<Outcome> {
  const record = recordOf(await reader.read(`${base}/releases/tags/v${encodeSegment(version)}`));
  if (record.kind === 'missing') return { status: 'missing', detail: `GitHub has no release for v${version}` };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the release could not be read' };
  const { draft, prerelease } = record.value;
  if (typeof draft !== 'boolean' || typeof prerelease !== 'boolean') return { status: 'unknown', detail: 'the release could not be read' };
  if (draft) return { status: 'missing', detail: 'the release is a draft' };
  const wanted = hasPrerelease(version);
  if (prerelease !== wanted) {
    return { status: 'missing', detail: wanted ? 'the release is not marked as a prerelease' : 'the release is marked as a prerelease' };
  }
  return { status: 'pass', detail: 'published release matches SemVer channel' };
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 9999 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day >= 1 && day <= days;
}

function changelogPart(text: string, version: string): Outcome {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const accepted = new RegExp(`^## (?:\\[${escaped}\\]|${escaped}) - ([0-9]{4})-([0-9]{2})-([0-9]{2})[ \t]*$`);
  const forVersion = new RegExp(`^## (?:\\[${escaped}\\]|${escaped}) - `);
  let named = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const match = accepted.exec(line);
    if (match && validDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      return { status: 'pass', detail: 'changelog entry has a valid release date' };
    }
    if (match || forVersion.test(line)) named = true;
  }
  return named
    ? { status: 'missing', detail: `the changelog entry for ${version} has an invalid date` }
    : { status: 'missing', detail: `CHANGELOG.md has no entry for ${version}` };
}

async function changelogCheck(reader: Reader, base: string, version: string, repo: Repo): Promise<Outcome> {
  if (repo.kind === 'missing') return { status: 'missing', detail: repo.detail };
  if (repo.kind === 'unknown') return { status: 'unknown', detail: repo.detail };
  const record = recordOf(await reader.read(`${base}/contents/CHANGELOG.md?ref=${encodeSegment(repo.branch)}`));
  if (record.kind === 'missing') return { status: 'missing', detail: 'the default branch has no CHANGELOG.md' };
  if (record.kind === 'unknown') return { status: 'unknown', detail: 'the changelog could not be read' };
  const value = record.value;
  if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') {
    return { status: 'unknown', detail: 'the changelog could not be read' };
  }
  const cleaned = value.content.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cleaned)) {
    return { status: 'unknown', detail: 'the changelog could not be read' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(cleaned, 'base64'));
  } catch {
    return { status: 'unknown', detail: 'the changelog could not be read' };
  }
  return changelogPart(text, version);
}

/**
 * The four checks of one release, in the output's order. The reads are sequential and
 * deterministic: npm (with its attestation when trusted publishing is declared), the repository
 * the tag and changelog checks share, the tag chain and compare, the release, the changelog.
 */
export async function runChecks(decl: ReleaseDecl, version: string, fetcher: Fetch, caps?: Caps): Promise<ReleaseResult> {
  const reader = new Reader(fetcher, caps);
  const [owner, repoName] = decl.github.split('/') as [string, string];
  const base = `https://api.github.com/repos/${encodeSegment(owner)}/${encodeSegment(repoName)}`;
  const npm = await npmCheck(reader, decl, version);
  const repo = await readRepo(reader, base, decl.github);
  const tag = await tagCheck(reader, base, version, repo);
  const github = await githubCheck(reader, base, version);
  const changelog = await changelogCheck(reader, base, version, repo);
  return { npm, tag, github, changelog };
}
