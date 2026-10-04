// `team release check` end to end: the specification's two output examples byte for byte, the
// exit codes, the error precedence, the exact URL set of one run, and read-only by construction.
// The fetch is the answer map throughout; one test stubs globalThis.fetch to see the production
// wiring's request — no test makes a real network request.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRelease } from '../../src/commands/release.ts';
import { realFetch, BODY_LIMIT } from '../../src/release/http.ts';
import type { KeyReader } from '../../src/release/keychain.ts';
import { testIo, type TestIo } from '../helpers.ts';
import {
  KEY, URLS, activityFile, fakeFetch, fixture, happy, happyRecords, json, linearAnswer, type Answers, type Recorded,
} from './world.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
releases:
  - package: material
    github: floor/material
    trusted_publishing: true
  - package: "@scope/tool"
    github: floor/tool
  - package: widgets
    github: floor/material
    linear_project: 01234567-89ab-cdef-0123-456789abcdef
    linear_keychain_service: team.linear.material
    activity_file: activity/2026/material.md
    activity_marker: "release: <package>@<version>"
  - package: gadgets
    github: floor/material
    activity_file: activity/2026/material.md
    activity_marker: "release: <package>@<version>"
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

// The specification's example run: npm pass with provenance, the tag not ancestral, the release
// and the changelog right — one check missing, exit 1.
function specAnswers(): Answers {
  return new Map([...happy(), [URLS.compare, json({ ...fixture('github-compare.json'), status: 'behind' })]]);
}

const SPEC_TABLE = `check      status   detail
npm        pass     exact version, checksums, and provenance found
tag        missing  tag commit is not an ancestor of the default branch
github     pass     published release matches SemVer channel
changelog  pass     changelog entry has a valid release date
`;

const SPEC_JSON = `{
  "package": "material",
  "version": "3.0.2",
  "checks": {
    "npm": { "status": "pass", "detail": "exact version, checksums, and provenance found" },
    "tag": { "status": "missing", "detail": "tag commit is not an ancestor of the default branch" },
    "github": { "status": "pass", "detail": "published release matches SemVer channel" },
    "changelog": { "status": "pass", "detail": "changelog entry has a valid release date" }
  }
}
`;

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'team-release-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project, stdio: ['ignore', 'ignore', 'ignore'] });
  mkdirSync(join(project, '.agents'));
  writeFileSync(join(project, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

async function run(argv: string[], answers: Answers, keyReader?: KeyReader): Promise<{ code: number; io: TestIo; requested: string[]; requests: Recorded[] }> {
  const { fetcher, requested, requests } = fakeFetch(answers);
  const io = testIo(project);
  return { code: await runRelease(argv, io, fetcher, keyReader), io, requested, requests };
}

function listing(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) out.push(...listing(join(dir, entry.name)).map((name) => `${entry.name}/${name}`));
    else out.push(entry.name);
  }
  return out.sort();
}

describe('the output', () => {
  test('the specification\'s table example, byte for byte, exit 1', async () => {
    const { code, io } = await run(['check', 'material@3.0.2'], specAnswers());
    expect(code).toBe(1);
    expect(io.out).toBe(SPEC_TABLE);
    expect(io.err).toBe('');
  });

  test('the specification\'s JSON example, byte for byte, exit 1', async () => {
    const { code, io } = await run(['check', 'material@3.0.2', '--json'], specAnswers());
    expect(code).toBe(1);
    expect(io.out).toBe(SPEC_JSON);
    expect(io.err).toBe('');
  });

  test('exit 0 when every check passes', async () => {
    const { code } = await run(['check', 'material@3.0.2'], happy());
    expect(code).toBe(0);
  });

  test('exit 2 when any check is unknown, even with another missing', async () => {
    const answers = specAnswers();
    answers.set(URLS.npm, [json({}, 500), json({}, 500)]);
    const { code, io } = await run(['check', 'material@3.0.2'], answers);
    expect(code).toBe(2);
    expect(io.out).toContain('npm        unknown');
  });

  test('one full run requests exactly the eleven endpoints, all HTTPS, in order', async () => {
    // The same maximal shape as the caps test: trusted publishing, a chain of tag objects.
    const { requested } = await run(['check', 'material@3.0.2'], happy());
    expect(requested).toEqual([URLS.npm, URLS.attest, URLS.repo, URLS.ref, URLS.compare, URLS.release, URLS.changelog]);
    for (const url of requested) expect(url).toStartWith('https://');
  });

  test('a scoped package splits at the final @ and encodes as one segment', async () => {
    const { code, requested } = await run(['check', '@scope/tool@1.2.3'], new Map());
    expect(code).toBe(2);
    expect(requested[0]).toBe('https://registry.npmjs.org/%40scope%2Ftool/1.2.3');
  });
});

// The records run for widgets@3.0.2 (both pairs configured, no trusted publishing): the same
// public records — the file points widgets at the same repository — plus the marker with the
// requested literal values and the Linear answer.
function widgetsAnswers(): Answers {
  const answers = happyRecords();
  answers.set('https://registry.npmjs.org/widgets/3.0.2', json({ ...fixture('npm-version.json'), name: 'widgets' }));
  answers.set(URLS.activity, json(activityFile('# Activity\n\nrelease: widgets@3.0.2\n')));
  return answers;
}

// gadgets configures the activity pair only.
function gadgetsAnswers(): Answers {
  const answers = happy(false);
  answers.set('https://registry.npmjs.org/gadgets/3.0.2', json({ ...fixture('npm-version.json'), name: 'gadgets' }));
  answers.set(URLS.activity, json(activityFile('release: gadgets@3.0.2\n')));
  return answers;
}

const okKey: KeyReader = () => Promise.resolve({ ok: true, key: KEY });

describe('the output with the records configured', () => {
  const WIDGETS_TABLE = `check      status  detail
npm        pass    exact version and checksums found
tag        pass    tag resolves to a commit on the default branch
github     pass    published release matches SemVer channel
changelog  pass    changelog entry has a valid release date
linear     pass    Linear milestone is complete and a qualifying status update exists
activity   pass    public activity marker found
`;

  const WIDGETS_JSON = `{
  "package": "widgets",
  "version": "3.0.2",
  "checks": {
    "npm": { "status": "pass", "detail": "exact version and checksums found" },
    "tag": { "status": "pass", "detail": "tag resolves to a commit on the default branch" },
    "github": { "status": "pass", "detail": "published release matches SemVer channel" },
    "changelog": { "status": "pass", "detail": "changelog entry has a valid release date" },
    "linear": { "status": "pass", "detail": "Linear milestone is complete and a qualifying status update exists" },
    "activity": { "status": "pass", "detail": "public activity marker found" }
  }
}
`;

  test('all six rows in the fixed order, exit 0', async () => {
    const { code, io } = await run(['check', 'widgets@3.0.2'], widgetsAnswers(), okKey);
    expect(code).toBe(0);
    expect(io.out).toBe(WIDGETS_TABLE);
    expect(io.err).toBe('');
  });

  test('the JSON object has exactly the six keys in the fixed order', async () => {
    const { code, io } = await run(['check', 'widgets@3.0.2', '--json'], widgetsAnswers(), okKey);
    expect(code).toBe(0);
    expect(io.out).toBe(WIDGETS_JSON);
    expect(io.err).toBe('');
  });

  test('a check that is not configured is absent: the activity pair alone adds one row', async () => {
    const { code, io } = await run(['check', 'gadgets@3.0.2'], gadgetsAnswers());
    expect(code).toBe(0);
    expect(io.out).toContain('activity   pass    public activity marker found');
    expect(io.out).not.toContain('linear');
  });

  test('the exit rule spans the present checks: a missing linear is 1, an unknown one is 2', async () => {
    const missing = await run(
      ['check', 'widgets@3.0.2'],
      new Map([...widgetsAnswers(), [URLS.linear, json(linearAnswer({ milestones: [] }))]]),
      okKey,
    );
    expect(missing.code).toBe(1);
    expect(missing.io.out).toContain('no matching Linear milestone found');

    const noKey: KeyReader = () => Promise.resolve({ ok: false, reason: 'the lookup failed' });
    const unknown = await run(['check', 'widgets@3.0.2'], widgetsAnswers(), noKey);
    expect(unknown.code).toBe(2);
    expect(unknown.io.out).toContain('Keychain access was unavailable');
  });

  test('without an injected reader, the non-interactive default never invokes the facility', async () => {
    // The default wiring reads io.stdinIsTTY — false here — and does not look up anything.
    const { code, io, requested } = await run(['check', 'widgets@3.0.2'], widgetsAnswers());
    expect(code).toBe(2);
    expect(io.out).toContain('Keychain access was unavailable');
    expect(requested).not.toContain(URLS.linear);
  });
});

describe('the key appears nowhere but the one request header', () => {
  // The key under test is the distinctive non-real string of world.ts. After each scenario,
  // everything the command produced is searched: standard output, standard error, any thrown
  // error's message and stack, the recorded requests (URLs, bodies, header names and values),
  // the arguments the fake key reader saw, and the project's file listing.
  const calls: string[] = [];
  const recording: KeyReader = (service) => {
    calls.push(service);
    return Promise.resolve({ ok: true, key: KEY });
  };

  function searched(io: TestIo, requests: Recorded[], thrown: unknown): number {
    const text = [io.out, io.err, thrown instanceof Error ? `${thrown.message}\n${thrown.stack ?? ''}` : String(thrown ?? '')].join('\n');
    expect(text).not.toContain(KEY);
    for (const service of calls) expect(service).toBe('team.linear.material');
    let carried = 0;
    for (const record of requests) {
      expect(record.url).not.toContain(KEY);
      expect(record.request?.body ?? '').not.toContain(KEY);
      for (const [name, value] of Object.entries(record.request?.headers ?? {})) {
        expect(name).not.toContain(KEY);
        if (value.includes(KEY)) {
          expect({ url: record.url, name }).toEqual({ url: URLS.linear, name: 'Authorization' });
          carried++;
        }
      }
    }
    return carried;
  }

  async function attempt(answers: Answers): Promise<{ code: number; io: TestIo; requests: Recorded[]; thrown: unknown }> {
    calls.length = 0;
    try {
      const { code, io, requests } = await run(['check', 'widgets@3.0.2'], answers, recording);
      return { code, io, requests, thrown: undefined };
    } catch (error) {
      // A throw is itself a finding to search: nothing the error carries may hold the key.
      return { code: -1, io: testIo(project), requests: [], thrown: error };
    }
  }

  test('all pass: exactly one attempt, exactly one header carries the key, nothing else does', async () => {
    const { code, io, requests, thrown } = await attempt(widgetsAnswers());
    expect(code).toBe(0);
    expect(searched(io, requests, thrown)).toBe(1);
    expect(calls).toEqual(['team.linear.material']);
  });

  test('401, 403, 500 twice, a timeout, invalid JSON, a 200 with errors, a redirect', async () => {
    const scenarios: [string, Answers, number][] = [
      ['401', new Map([...widgetsAnswers(), [URLS.linear, json({}, 401)]]), 1],
      ['403', new Map([...widgetsAnswers(), [URLS.linear, json({}, 403)]]), 1],
      ['500 twice', new Map([...widgetsAnswers(), [URLS.linear, [json({}, 500), json({}, 500)]]]), 2],
      ['a timeout', new Map([...widgetsAnswers(), [URLS.linear, { kind: 'timeout' }]]), 2],
      ['invalid JSON', new Map([...widgetsAnswers(), [URLS.linear, { kind: 'http', status: 200, body: '{"data":' }]]), 1],
      ['200 with errors', new Map([...widgetsAnswers(), [URLS.linear, json({ data: null, errors: [{ message: 'nope' }] })]]), 1],
      ['a redirect', new Map([...widgetsAnswers(), [URLS.linear, json({}, 302)]]), 1],
    ];
    for (const [name, answers, attempts] of scenarios) {
      const { code, io, requests, thrown } = await attempt(answers);
      expect({ name, code }).toEqual({ name, code: 2 });
      expect(io.out).toContain('Linear record could not be read');
      expect(searched(io, requests, thrown)).toBe(attempts);
    }
  });

  test('the key reader fails: no request is formed, the key appears nowhere at all', async () => {
    const failing: KeyReader = () => Promise.resolve({ ok: false, reason: 'the lookup failed' });
    const { code, io, requests } = await run(['check', 'widgets@3.0.2'], widgetsAnswers(), failing);
    expect(code).toBe(2);
    expect(io.out).toContain('Keychain access was unavailable');
    expect(requests.filter((record) => record.url === URLS.linear)).toEqual([]);
    expect(searched(io, requests, undefined)).toBe(0);
  });

  test('a response body that itself contains the key string is not echoed anywhere', async () => {
    const answers = new Map([...widgetsAnswers(), [URLS.linear, json(linearAnswer({ milestones: [{ name: KEY, status: 'done' }] }))]]);
    const { code, io, requests, thrown } = await attempt(answers);
    expect(code).toBe(1);
    expect(io.out).toContain('no matching Linear milestone found');
    expect(searched(io, requests, thrown)).toBe(1);
  });

  test('the records run writes nothing: the project is byte-identical afterwards', async () => {
    const before = listing(project);
    await attempt(widgetsAnswers());
    expect(listing(project)).toEqual(before);
  });
});

describe('read-only by construction', () => {
  test('the run writes nothing: the project is byte-identical afterwards', async () => {
    const before = listing(project);
    await run(['check', 'material@3.0.2'], happy());
    expect(listing(project)).toEqual(before);
  });

  test('its modules import no filesystem write and, but for the one Keychain seam, no process spawn', () => {
    for (const module of ['commands/release.ts', 'release/checks.ts', 'release/http.ts', 'release/grammar.ts', 'release/keychain.ts', 'file/sections/releases.ts']) {
      const source = readFileSync(join(import.meta.dir, '..', '..', 'src', module), 'utf8');
      expect(source).not.toContain("from 'node:fs'");
      expect(source).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync/);
      // The Keychain seam is the command's one sanctioned spawn; every test stands in for it.
      if (module !== 'release/keychain.ts') expect(source).not.toContain('node:child_process');
    }
  });
});

describe('the production wiring', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test('sends no authorization header, follows no redirect, sets the timeout', async () => {
    let seen: RequestInit | undefined;
    let asked = false;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      asked = true;
      seen = init;
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof fetch;
    const attempt = await realFetch('https://registry.npmjs.org/material/3.0.2');
    expect(attempt).toEqual({ kind: 'http', status: 200, body: '{"ok":true}' });
    expect(asked).toBe(true);
    expect(seen?.headers).toBeUndefined();
    expect(JSON.stringify(seen ?? {})).not.toContain('uthorization');
    expect(seen?.redirect).toBe('manual');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a body over one megabyte decoded is the size-limit failure, with the response status', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('x'.repeat(BODY_LIMIT + 1), { status: 200 }))) as unknown as typeof fetch;
    expect(await realFetch('https://registry.npmjs.org/material/3.0.2')).toEqual({ kind: 'too-large', status: 200 });
  });

  test('a body that is not valid UTF-8 is the undecodable failure, with the response status', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), { status: 200 }))) as unknown as typeof fetch;
    expect(await realFetch('https://registry.npmjs.org/material/3.0.2')).toEqual({ kind: 'undecodable', status: 200 });
  });
});

describe('the usage and configuration errors', () => {
  test('each misuse exits 64 with one diagnostic on stderr and no table', async () => {
    const cases: string[][] = [
      [],
      ['status'],
      ['check'],
      ['check', 'material@3.0.2', 'extra'],
      ['check', 'material@3.0.2', '--table'],
      ['check', 'material'],
      ['check', '@1.2.3'],
      ['check', 'Material@3.0.2'],
      ['check', 'material@v3.0.2'],
      ['check', 'material@3.0'],
      ['check', 'material@03.0.2'],
    ];
    for (const argv of cases) {
      const { code, io, requested } = await run(argv, happy());
      expect({ argv, code }).toEqual({ argv, code: 64 });
      expect(io.out).toBe('');
      const lines = io.err.split('\n').filter((line) => line !== '');
      expect(lines.length).toBe(1);
      expect(lines[0]).toStartWith('team release: ');
      expect(requested).toEqual([]);
    }
  });

  test('with --json a misuse is the exact error object on stdout, nothing on stderr', async () => {
    const { code, io } = await run(['check', 'material@v3.0.2', '--json'], happy());
    expect(code).toBe(64);
    expect(io.out).toBe('{"error":{"code":"usage","message":"the version \\"v3.0.2\\" is not a Semantic Versioning 2.0.0 version"}}\n');
    expect(io.err).toBe('');
  });

  test('--json decides the reporting wherever it appears, even after an unknown option', async () => {
    for (const argv of [
      ['check', 'material@3.0.2', '--bogus', '--json'],
      ['--json', 'check', 'material@3.0.2', '--bogus'],
    ]) {
      const { code, io } = await run(argv, happy());
      expect({ argv, code }).toEqual({ argv, code: 64 });
      expect(io.out).toBe('{"error":{"code":"usage","message":"unknown option --bogus"}}\n');
      expect(io.err).toBe('');
    }
  });

  test('the precedence: an invalid argument is usage even when the file is invalid', async () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 1\nproject: acme\n');
    const { code, io } = await run(['check', 'material@v3.0.2', '--json'], happy());
    expect(code).toBe(64);
    expect(JSON.parse(io.out)).toEqual({ error: { code: 'usage', message: 'the version "v3.0.2" is not a Semantic Versioning 2.0.0 version' } });
  });

  test('a valid argument with an invalid file is configuration', async () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 1\nproject: acme\n');
    const { code, io } = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(code).toBe(64);
    const parsed = JSON.parse(io.out) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('configuration');
    expect(parsed.error.message.length).toBeGreaterThan(0);
    expect(io.err).toBe('');

    const plain = await run(['check', 'material@3.0.2'], happy());
    expect(plain.code).toBe(64);
    expect(plain.io.out).toBe('');
    expect(plain.io.err.split('\n').filter((line) => line !== '').length).toBe(1);
    expect(plain.io.err).toContain('team release: ');
  });

  test('an undeclared package is usage, with and without a releases section', async () => {
    const { code, io } = await run(['check', 'other@3.0.2', '--json'], happy());
    expect(code).toBe(64);
    expect(JSON.parse(io.out)).toEqual({ error: { code: 'usage', message: 'other is not declared in the team file\'s releases' } });

    writeFileSync(join(project, '.agents', 'team.yaml'), TEAM.replace(/^releases:\n(?:  .*\n)+/m, ''));
    const bare = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(bare.code).toBe(64);
    expect(JSON.parse(bare.io.out)).toEqual({ error: { code: 'usage', message: 'material is not declared in the team file\'s releases' } });
  });

  test('a file that fails validation because of its releases section is configuration', async () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), TEAM.replace('seats:', '  - package: material\n    github: floor/other\nseats:'));
    const { code, io } = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(code).toBe(64);
    const parsed = JSON.parse(io.out) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('configuration');
    expect(parsed.error.message).toContain('releases names "material" twice');
  });
});
