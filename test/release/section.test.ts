// The `releases:` section: what the file accepts and refuses, the refusals as `team doctor`
// reports them, and the proof that adding the section leaves an existing approval untouched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprints } from '../../src/approve/fingerprint.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { testIo } from '../helpers.ts';

const FILE = (releases: string): string => `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
${releases}seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function problems(text: string): string[] {
  const result = validateTeamFile(text);
  return result.ok ? [] : result.errors.map((error) => error.message);
}

describe('the releases section', () => {
  test('a file without it validates, with no releases', () => {
    const result = validateTeamFile(FILE(''));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.team.releases).toEqual([]);
  });

  test('a full section validates, trusted and untrusted', () => {
    const result = validateTeamFile(FILE(`releases:
  - package: material
    github: floor/material
    trusted_publishing: true
  - package: "@scope/tool"
    github: floor/tool
`));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.releases).toEqual([
        { package: 'material', github: 'floor/material', trustedPublishing: true },
        { package: '@scope/tool', github: 'floor/tool', trustedPublishing: false },
      ]);
    }
  });

  test('an unknown key is refused', () => {
    expect(problems(FILE(`releases:
  - package: material
    github: floor/material
    provenance: true
`))).toContain('unknown field "provenance" in a release');
  });

  test('a duplicate package is refused', () => {
    expect(problems(FILE(`releases:
  - package: material
    github: floor/material
  - package: material
    github: floor/other
`))).toContain('releases names "material" twice');
  });

  test('a string "true", yes, True and 1 are refused for trusted_publishing', () => {
    for (const value of ['"true"', 'yes', 'True', '1', 'on']) {
      expect(problems(FILE(`releases:
  - package: material
    github: floor/material
    trusted_publishing: ${value}
`))).toContain('a release\'s trusted_publishing must be the boolean true or false');
    }
  });

  test('an empty sequence is refused, both spellings', () => {
    expect(problems(FILE('releases: []\n'))).toContain('releases must name at least one package');
    expect(problems(FILE('releases:\n'))).toContain('releases must be a list of package entries');
  });

  test('a non-list, a non-map item, missing fields and bad values are refused', () => {
    expect(problems(FILE('releases: { package: material }\n'))).toContain('releases must be a list of package entries');
    expect(problems(FILE('releases:\n  - material\n'))).toContain('each release must be a map with package and github');
    expect(problems(FILE('releases:\n  - github: floor/material\n'))).toContain('a release\'s package is required');
    expect(problems(FILE('releases:\n  - package: material\n'))).toContain('a release\'s github is required');
    expect(problems(FILE('releases:\n  - package: Material\n    github: floor/material\n'))).toContain(
      'a release\'s package "Material" is not a package name',
    );
    expect(problems(FILE('releases:\n  - package: material\n    github: floor\n'))).toContain(
      'a release\'s github "floor" is not an owner/repo',
    );
    expect(problems(FILE('releases:\n  - package: 3\n    github: floor/material\n'))).toContain(
      'a release\'s package must be text: quote it',
    );
  });
});

describe('the release records keys', () => {
  const PROJECT = '01234567-89ab-cdef-0123-456789abcdef';

  test('both pairs validate, and the declaration carries them', () => {
    const result = validateTeamFile(FILE(`releases:
  - package: material
    github: floor/material
    linear_project: ${PROJECT}
    linear_keychain_service: team.linear.material
    activity_file: activity/2026/material.md
    activity_marker: "release: <package>@<version>"
`));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.releases[0]).toEqual({
        package: 'material',
        github: 'floor/material',
        trustedPublishing: false,
        linear: { project: PROJECT, keychainService: 'team.linear.material' },
        activity: { file: 'activity/2026/material.md', marker: 'release: <package>@<version>' },
      });
    }
  });

  test('half a pair is refused, both pairs, both directions', () => {
    expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    linear_project: ${PROJECT}\n`))).toContain(
      'a release\'s linear_project and linear_keychain_service come together',
    );
    expect(problems(FILE('releases:\n  - package: material\n    github: floor/material\n    linear_keychain_service: team.linear.material\n'))).toContain(
      'a release\'s linear_project and linear_keychain_service come together',
    );
    expect(problems(FILE('releases:\n  - package: material\n    github: floor/material\n    activity_file: activity/2026/material.md\n'))).toContain(
      'a release\'s activity_file and activity_marker come together',
    );
    expect(problems(FILE('releases:\n  - package: material\n    github: floor/material\n    activity_marker: "release: <package>@<version>"\n'))).toContain(
      'a release\'s activity_file and activity_marker come together',
    );
  });

  test('a malformed project id is refused: uppercase, short, non-hex, not a UUID', () => {
    for (const id of ['01234567-89AB-cdef-0123-456789abcdef', '01234567-89ab-cdef-0123-456789abcde', 'g1234567-89ab-cdef-0123-456789abcdef', 'not-a-uuid']) {
      expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    linear_project: ${id}\n    linear_keychain_service: team.linear.material\n`))).toContain(
        `a release's linear_project ${JSON.stringify(id)} is not a lowercase UUID`,
      );
    }
  });

  test('a service over 255 bytes, an empty service or a non-string is refused', () => {
    const long = 's'.repeat(256);
    expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    linear_project: ${PROJECT}\n    linear_keychain_service: ${long}\n`))).toContain(
      'a release\'s linear_keychain_service is over 255 bytes',
    );
    expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    linear_project: ${PROJECT}\n    linear_keychain_service: 3\n`))).toContain(
      'a release\'s linear_keychain_service must be text: quote it',
    );
  });

  test('a bad activity file is refused: a dot segment, an empty segment, non-ASCII, too long', () => {
    for (const file of ['activity/../material.md', 'activity//material.md', '/activity/material.md', 'activity/mâtériel.md']) {
      expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    activity_file: "${file}"\n    activity_marker: "release: <package>@<version>"\n`)).join('\n')).toContain(
        'a release\'s activity_file',
      );
    }
    const long = `a${'/b'.repeat(256)}`;
    expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    activity_file: "${long}"\n    activity_marker: "release: <package>@<version>"\n`))).toContain(
      'a release\'s activity_file is over 512 bytes',
    );
  });

  test('a bad activity marker is refused: a missing or doubled slot, over 200 bytes', () => {
    for (const marker of ['release: <package>', 'release: <package>@<version> and <package> again', 'release: <version>@<version>']) {
      expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    activity_file: activity/2026/material.md\n    activity_marker: "${marker}"\n`)).join('\n')).toContain(
        'a release\'s activity_marker must have exactly one',
      );
    }
    const long = `release: <package>@<version> ${'x'.repeat(200)}`;
    expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    activity_file: activity/2026/material.md\n    activity_marker: "${long}"\n`))).toContain(
      'a release\'s activity_marker is over 200 bytes',
    );
  });

  test('the section holds no key: an unknown key beside the pairs is still refused', () => {
    expect(problems(FILE(`releases:\n  - package: material\n    github: floor/material\n    linear_project: ${PROJECT}\n    linear_keychain_service: team.linear.material\n    linear_key: abc\n`))).toContain(
      'unknown field "linear_key" in a release',
    );
  });
});

// The refusals as the owner sees them: `team doctor` fails the file, with the line and the message.
describe('team doctor', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'team-release-doctor-'));
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project, stdio: ['ignore', 'ignore', 'ignore'] });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const refused: [string, string][] = [
    ['an unknown key', 'unknown field "provenance" in a release'],
    ['a duplicate package', 'releases names "material" twice'],
    ['a string "true"', 'trusted_publishing must be the boolean true or false'],
    ['yes', 'trusted_publishing must be the boolean true or false'],
    ['an empty sequence', 'releases must name at least one package'],
  ];
  const files: Record<string, string> = {
    'an unknown key': 'releases:\n  - package: material\n    github: floor/material\n    provenance: true\n',
    'a duplicate package': 'releases:\n  - package: material\n    github: floor/material\n  - package: material\n    github: floor/other\n',
    'a string "true"': 'releases:\n  - package: material\n    github: floor/material\n    trusted_publishing: "true"\n',
    yes: 'releases:\n  - package: material\n    github: floor/material\n    trusted_publishing: yes\n',
    'an empty sequence': 'releases: []\n',
  };

  // The file never loads, so the doctor's sources are never read.
  const sources = {} as DoctorSources;

  for (const [name, message] of refused) {
    test(`fails on ${name}`, async () => {
      writeFileSync(join(project, 'team.yaml'), FILE(files[name] as string));
      const io = testIo(project);
      const code = await runDoctor(['--file', 'team.yaml'], io, sources);
      expect(code).toBe(2);
      expect(io.err).toContain(message);
    });
  }

  test('the new keys are validated by shape only: nothing is read, no source is touched', async () => {
    // The proof that doctor makes no network request and reads no key for the new keys: the
    // sources stand in for everything doctor could read from the machine, and every one of them
    // throws if so much as looked at — the configuration errors are still reported.
    const sources = new Proxy({} as DoctorSources, {
      get(_target, property) {
        throw new Error(`doctor read a source: ${String(property)}`);
      },
    });
    writeFileSync(
      join(project, 'team.yaml'),
      FILE('releases:\n  - package: material\n    github: floor/material\n    linear_project: not-a-uuid\n'),
    );
    const io = testIo(project);
    const code = await runDoctor(['--file', 'team.yaml'], io, sources);
    expect(code).toBe(2);
    expect(io.err).toContain('a release\'s linear_project and linear_keychain_service come together');

    // And with the whole pair present, the shape itself is refused — still without a read.
    writeFileSync(
      join(project, 'team.yaml'),
      FILE('releases:\n  - package: material\n    github: floor/material\n    linear_project: not-a-uuid\n    linear_keychain_service: team.linear.material\n'),
    );
    const second = testIo(project);
    expect(await runDoctor(['--file', 'team.yaml'], second, sources)).toBe(2);
    expect(second.err).toContain('a release\'s linear_project "not-a-uuid" is not a lowercase UUID');
  });
});

describe('the approval fingerprint', () => {
  test('a file with and without releases: fingerprints identically', () => {
    const without = validateTeamFile(FILE(''));
    const withSection = validateTeamFile(FILE('releases:\n  - package: material\n    github: floor/material\n'));
    if (!without.ok || !withSection.ok) throw new Error('both files validate');
    expect(fingerprints(withSection.team)).toEqual(fingerprints(without.team));
  });
});
