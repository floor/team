import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import { GITHUB_PATTERN, PACKAGE_BYTES, PACKAGE_PATTERN } from '../../release/grammar.ts';
import type { Section } from './section.ts';

/** One package the team publishes, as `team release check` reads it. */
export interface ReleaseDecl {
  package: string;
  github: string;
  /** True when npm provenance is required for the package's releases. */
  trustedPublishing: boolean;
}

/**
 * The packages whose public npm and GitHub records `team release check` verifies. Not an owner
 * section: it names public records and grants a seat nothing — the command it feeds is read-only
 * and credential-free, so an edit here needs no approval, and an existing approval never drifts
 * when the section appears.
 */
export const releases: Section = {
  name: 'releases',
  owner: false,
  after: [],
  validate(entry, ctx) {
    return readReleases(entry, ctx.check);
  },
  schema: {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        package: {
          type: 'string',
          pattern: '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$',
          maxLength: PACKAGE_BYTES,
        },
        github: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' },
        trusted_publishing: { type: 'boolean' },
      },
      required: ['package', 'github'],
    },
    $comment: 'the packages `team release check` verifies; the validator also refuses a package named twice and a non-boolean trusted_publishing',
  },
};

function readReleases(entry: YamlEntry | undefined, check: Check): ReleaseDecl[] {
  const out: ReleaseDecl[] = [];
  if (!entry) return out;
  const node = entry.value;
  if (node.kind !== 'seq') {
    check.fail(node.line, 'releases must be a list of package entries');
    return out;
  }
  if (node.items.length === 0) {
    check.fail(node.line, 'releases must name at least one package');
    return out;
  }
  const seen = new Set<string>();
  for (const item of node.items) {
    if (item.kind !== 'map') {
      check.fail(item.line, 'each release must be a map with package and github');
      continue;
    }
    const fields = check.fields(item, 'a release', ['package', 'github', 'trusted_publishing']);
    const name = check.required(fields.get('package'), 'a release\'s package', item.line) ?? '';
    if (name && !PACKAGE_PATTERN.test(name)) {
      check.fail(fields.get('package')?.line ?? item.line, `a release's package ${JSON.stringify(name)} is not a package name`);
    }
    if (name && new TextEncoder().encode(name).length > PACKAGE_BYTES) {
      check.fail(fields.get('package')?.line ?? item.line, `a release's package is over ${PACKAGE_BYTES} bytes`);
    }
    const github = check.required(fields.get('github'), 'a release\'s github', item.line) ?? '';
    if (github && !GITHUB_PATTERN.test(github)) {
      check.fail(fields.get('github')?.line ?? item.line, `a release's github ${JSON.stringify(github)} is not an owner/repo`);
    }
    if (name && seen.has(name)) {
      check.fail(fields.get('package')?.line ?? item.line, `releases names ${JSON.stringify(name)} twice`);
    }
    if (name) seen.add(name);
    out.push({ package: name, github, trustedPublishing: trusted(fields.get('trusted_publishing'), check) });
  }
  return out;
}

// Only the boolean token, as the specification says: not a quoted string, not yes/no/on/off
// (those read as text in this YAML subset and fail here), and not True/TRUE.
function trusted(entry: YamlEntry | undefined, check: Check): boolean {
  if (!entry) return false;
  const node = entry.value;
  if (node.kind === 'scalar' && typeof node.value === 'boolean' && !node.quoted && (node.raw === 'true' || node.raw === 'false')) {
    return node.value;
  }
  check.fail(node.line, 'a release\'s trusted_publishing must be the boolean true or false');
  return false;
}
