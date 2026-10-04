// The recorded npm and GitHub answers the release tests replay, and a fetch that serves them.
// No test here makes a real network request: the fetch is this map, and an unlisted URL is a
// transport failure the test can see in `requested`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Fetch } from '../../src/release/http.ts';
import type { ReleaseDecl } from '../../src/file/sections/releases.ts';

export const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'release');

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

export function json(value: unknown, status = 200): Attempt {
  return { kind: 'http', status, body: JSON.stringify(value) };
}

export type Answers = Map<string, Attempt | Attempt[]>;

export function fakeFetch(answers: Answers): { fetcher: Fetch; requested: string[] } {
  const requested: string[] = [];
  const used = new Map<string, number>();
  const fetcher: Fetch = (url) => {
    requested.push(url);
    const answer = answers.get(url);
    if (answer === undefined) return Promise.resolve({ kind: 'transport' });
    if (Array.isArray(answer)) {
      const at = used.get(url) ?? 0;
      used.set(url, at + 1);
      return Promise.resolve(answer[Math.min(at, answer.length - 1)] as Attempt);
    }
    return Promise.resolve(answer);
  };
  return { fetcher, requested };
}

export const COMMIT = '1111111111111111111111111111111111111111';
export const TAG_OBJECT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const MATERIAL: ReleaseDecl = { package: 'material', github: 'floor/material', trustedPublishing: true };

export const URLS = {
  npm: 'https://registry.npmjs.org/material/3.0.2',
  attest: 'https://registry.npmjs.org/-/npm/v1/attestations/material%403.0.2',
  repo: 'https://api.github.com/repos/floor/material',
  ref: 'https://api.github.com/repos/floor/material/git/ref/tags/v3.0.2',
  tagObject: `https://api.github.com/repos/floor/material/git/tags/${TAG_OBJECT}`,
  compare: `https://api.github.com/repos/floor/material/compare/${COMMIT}...main`,
  release: 'https://api.github.com/repos/floor/material/releases/tags/v3.0.2',
  changelog: 'https://api.github.com/repos/floor/material/contents/CHANGELOG.md?ref=main',
};

/** Every read of one passing run for material@3.0.2, trusted publishing declared. */
export function happy(trusted = true): Answers {
  const answers: Answers = new Map([
    [URLS.npm, json(fixture('npm-version.json'))],
    [URLS.repo, json(fixture('github-repo.json'))],
    [URLS.ref, json(fixture('github-tag-ref-lightweight.json'))],
    [URLS.compare, json(fixture('github-compare.json'))],
    [URLS.release, json(fixture('github-release.json'))],
    [URLS.changelog, json(fixture('github-contents.json'))],
  ]);
  if (trusted) answers.set(URLS.attest, json(fixture('npm-attestations.json')));
  return answers;
}

/** A tag object in an annotated chain: `from` reads as a tag object pointing at `to`. */
export function tagObject(sha: string, toSha: string, toType: string): Record<string, unknown> {
  return { sha, tag: 'v3.0.2', object: { sha: toSha, type: toType } };
}

/** A CHANGELOG.md contents response holding `text`. */
export function changelog(text: string): Record<string, unknown> {
  return {
    name: 'CHANGELOG.md',
    path: 'CHANGELOG.md',
    type: 'file',
    encoding: 'base64',
    content: `${Buffer.from(text, 'utf8').toString('base64')}\n`,
  };
}

export function withChange(answers: Answers, url: string, change: (value: Record<string, unknown>) => unknown): Answers {
  const answer = answers.get(url);
  if (answer === undefined || Array.isArray(answer) || answer.kind !== 'http') throw new Error(`no JSON answer for ${url}`);
  answers.set(url, json(change(JSON.parse(answer.body) as Record<string, unknown>)));
  return answers;
}

/** Replace one endpoint's answer outright — a status, a failure kind, or an attempt sequence. */
export function withAnswer(answers: Answers, url: string, answer: Attempt | Attempt[]): Answers {
  answers.set(url, answer);
  return answers;
}
