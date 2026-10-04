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
});

describe('the approval fingerprint', () => {
  test('a file with and without releases: fingerprints identically', () => {
    const without = validateTeamFile(FILE(''));
    const withSection = validateTeamFile(FILE('releases:\n  - package: material\n    github: floor/material\n'));
    if (!without.ok || !withSection.ok) throw new Error('both files validate');
    expect(fingerprints(withSection.team)).toEqual(fingerprints(without.team));
  });
});
