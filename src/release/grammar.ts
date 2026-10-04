// The grammars of the `releases:` section and of `team release check`'s argument, in one place so
// the section and the command cannot drift apart: a package the file accepts is a package the
// command accepts, and the version argument is the SemVer 2.0.0 grammar the checks are read against.

/** An npm package name: an optional scope, then the name; lowercase ASCII, npm's own shape. */
export const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** npm's length limit on a package name, in bytes. */
export const PACKAGE_BYTES = 214;

const GITHUB_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';

/** A GitHub `owner/repo`: exactly two slash-separated segments. */
export const GITHUB_PATTERN = new RegExp(`^${GITHUB_SEGMENT}/${GITHUB_SEGMENT}$`);

// Semantic Versioning 2.0.0 (semver.org/spec/v2.0.0): decimal integers without leading zeros,
// dot-separated prerelease and build identifiers, numeric prerelease identifiers without leading
// zeros. No leading `v` — the tag and the release carry that, the version does not.
const CORE = '(?:0|[1-9][0-9]*)';
const PRERELEASE_IDENT = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const BUILD_IDENT = '[0-9a-zA-Z-]+';
export const SEMVER_PATTERN = new RegExp(
  `^${CORE}\\.${CORE}\\.${CORE}` +
    `(?:-${PRERELEASE_IDENT}(?:\\.${PRERELEASE_IDENT})*)?` +
    `(?:\\+${BUILD_IDENT}(?:\\.${BUILD_IDENT})*)?$`,
);

/** Why a string is not a package name, or null when it is one. */
export function packageProblem(name: string): string | null {
  if (!PACKAGE_PATTERN.test(name)) return 'is not a package name';
  if (new TextEncoder().encode(name).length > PACKAGE_BYTES) return `is over ${PACKAGE_BYTES} bytes`;
  return null;
}

/** True when a valid SemVer version carries a prerelease part (the build part never decides it). */
export function hasPrerelease(version: string): boolean {
  return (version.split('+')[0] as string).includes('-');
}
