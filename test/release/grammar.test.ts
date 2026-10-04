// The grammars of the `releases:` section and the command's argument: Semantic Versioning 2.0.0,
// the npm package name, and the GitHub owner/repo, accepted and refused cases.
import { describe, expect, test } from 'bun:test';
import { GITHUB_PATTERN, PACKAGE_PATTERN, SEMVER_PATTERN, hasPrerelease, packageProblem } from '../../src/release/grammar.ts';

describe('the SemVer 2.0.0 grammar', () => {
  const accepted = [
    '0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x-y-z.-',
    '1.0.0-0a', '1.0.0-alpha-1', '1.0.0+build.1', '1.0.0+20130313144700', '1.0.0-alpha+001',
    '1.0.0-rc.1+build-5', '9999.9999.9999',
  ];
  const refused = [
    'v1.2.3', 'V1.2.3', '1.2', '1.2.3.4', '1', '01.2.3', '1.02.3', '1.2.03', '1.0.0-01',
    '1.0.0-', '1.0.0+', '1.0.0-alpha..1', '1.0.0-alpha.01', '1.2.3 ', ' 1.2.3', '1.2.3+é',
    '', '3.0.2\n', '1.2.3-alpha_beta',
  ];
  for (const version of accepted) test(`accepts ${version}`, () => expect(SEMVER_PATTERN.test(version)).toBe(true));
  for (const version of refused) test(`refuses ${JSON.stringify(version)}`, () => expect(SEMVER_PATTERN.test(version)).toBe(false));

  test('the prerelease part, never the build part, decides the channel', () => {
    expect(hasPrerelease('1.0.0-alpha')).toBe(true);
    expect(hasPrerelease('1.0.0-alpha.1+x-y')).toBe(true);
    expect(hasPrerelease('1.0.0')).toBe(false);
    expect(hasPrerelease('1.0.0+build-x')).toBe(false);
  });
});

describe('the package grammar', () => {
  const accepted = ['material', '@scope/name', 'a', '@a/b', 'my-pkg.name_2', '@scope-2/name.x.y', 'vlist'];
  const refused = [
    'Material', '-material', '.material', '_material', 'material/name', '@scope', '@scope/',
    '@scope//name', '@Scope/name', '@scope/Name', '@scope/name/extra', 'material name', 'matérial',
    '', '@/name', '@scope/name ',
  ];
  for (const name of accepted) test(`accepts ${name}`, () => expect(packageProblem(name)).toBeNull());
  for (const name of refused) test(`refuses ${JSON.stringify(name)}`, () => expect(packageProblem(name)).not.toBeNull());

  test('refuses a name over 214 bytes', () => {
    expect(packageProblem(`@s/${'a'.repeat(211)}`)).toBeNull(); // 214 bytes exactly
    expect(packageProblem('a'.repeat(215))).not.toBeNull();
    expect(packageProblem('a'.repeat(214))).toBeNull();
  });
});

describe('the github grammar', () => {
  const accepted = ['floor/material', 'a/b', 'Floor-IO/material.addons_1', `${'x'.repeat(100)}/y`];
  const refused = [
    'floor', 'floor/material/extra', '/material', 'floor/', 'floor//material', 'floor /material',
    'floor/material ', '.floor/material', '-floor/material', 'floor/.material', 'floor/mate riàl',
    `${'x'.repeat(101)}/y`, '', 'floor/mat:rial',
  ];
  for (const repo of accepted) test(`accepts ${repo.length > 30 ? 'a 100-character owner' : repo}`, () => expect(GITHUB_PATTERN.test(repo)).toBe(true));
  for (const repo of refused) test(`refuses ${JSON.stringify(repo.length > 30 ? 'a 101-character owner' : repo)}`, () => expect(GITHUB_PATTERN.test(repo)).toBe(false));
});
