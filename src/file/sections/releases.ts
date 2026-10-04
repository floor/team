import type { YamlEntry } from '../../yaml.ts';
import type { Check } from '../check.ts';
import {
  GITHUB_PATTERN,
  LINEAR_PROJECT_PATTERN,
  PACKAGE_BYTES,
  PACKAGE_PATTERN,
  activityFileProblem,
  activityMarkerProblem,
  keychainServiceProblem,
} from '../../release/grammar.ts';
import type { Section } from './section.ts';

/** One package the team publishes, as `team release check` reads it. */
export interface ReleaseDecl {
  package: string;
  github: string;
  /** True when npm provenance is required for the package's releases. */
  trustedPublishing: boolean;
  /** The Linear record of the release: the project, and the Keychain service naming the key. */
  linear?: { project: string; keychainService: string };
  /** The public activity record of the release: the file, and the marker line to find in it. */
  activity?: { file: string; marker: string };
}

/**
 * The packages whose public npm and GitHub records `team release check` verifies. Not an owner
 * section: it names public records and grants a seat nothing — the command it feeds is read-only,
 * and the Linear key it may name lives in the owner's Keychain, never in this file — so an edit
 * here needs no approval, and an existing approval never drifts when the section appears.
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
        linear_project: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
        linear_keychain_service: { type: 'string', maxLength: 255 },
        activity_file: { type: 'string', maxLength: 512 },
        activity_marker: { type: 'string', maxLength: 200 },
      },
      required: ['package', 'github'],
    },
    $comment:
      'the packages `team release check` verifies; the validator also refuses a package named twice, a non-boolean ' +
      'trusted_publishing, half of the linear or activity pair, and a malformed project, service, file or marker',
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
    const fields = check.fields(item, 'a release', [
      'package',
      'github',
      'trusted_publishing',
      'linear_project',
      'linear_keychain_service',
      'activity_file',
      'activity_marker',
    ]);
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
    out.push({
      package: name,
      github,
      trustedPublishing: trusted(fields.get('trusted_publishing'), check),
      ...linear(fields, item.line, check),
      ...activity(fields, item.line, check),
    });
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

// The linear pair: both keys or neither, the project a canonical lowercase UUID, the service a
// Keychain service name (never a key). The file holds no key.
function linear(fields: Map<string, YamlEntry>, line: number, check: Check): Pick<ReleaseDecl, 'linear'> {
  const projectEntry = fields.get('linear_project');
  const serviceEntry = fields.get('linear_keychain_service');
  if (!projectEntry && !serviceEntry) return {};
  if (!projectEntry || !serviceEntry) {
    check.fail((projectEntry ?? serviceEntry)?.line ?? line, 'a release\'s linear_project and linear_keychain_service come together');
    return {};
  }
  const project = check.text(projectEntry, 'a release\'s linear_project') ?? '';
  if (project && !LINEAR_PROJECT_PATTERN.test(project)) {
    check.fail(projectEntry.line, `a release's linear_project ${JSON.stringify(project)} is not a lowercase UUID`);
  }
  const service = check.text(serviceEntry, 'a release\'s linear_keychain_service') ?? '';
  const serviceProblem = service === '' ? null : keychainServiceProblem(service);
  if (serviceProblem !== null) {
    check.fail(serviceEntry.line, `a release's linear_keychain_service ${serviceProblem}`);
  }
  return { linear: { project, keychainService: service } };
}

// The activity pair: both keys or neither, the file a repository-relative path of name segments,
// the marker with exactly one <package> and one <version> slot.
function activity(fields: Map<string, YamlEntry>, line: number, check: Check): Pick<ReleaseDecl, 'activity'> {
  const fileEntry = fields.get('activity_file');
  const markerEntry = fields.get('activity_marker');
  if (!fileEntry && !markerEntry) return {};
  if (!fileEntry || !markerEntry) {
    check.fail((fileEntry ?? markerEntry)?.line ?? line, 'a release\'s activity_file and activity_marker come together');
    return {};
  }
  const file = check.text(fileEntry, 'a release\'s activity_file') ?? '';
  const fileProblem = file === '' ? null : activityFileProblem(file);
  if (fileProblem !== null) {
    check.fail(fileEntry.line, `a release's activity_file ${fileProblem}`);
  }
  const marker = check.text(markerEntry, 'a release\'s activity_marker') ?? '';
  const markerProblem = marker === '' ? null : activityMarkerProblem(marker);
  if (markerProblem !== null) {
    check.fail(markerEntry.line, `a release's activity_marker ${markerProblem}`);
  }
  return { activity: { file, marker } };
}
