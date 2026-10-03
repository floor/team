import { CLIS } from '../clis.ts';
import { YamlError, parseYaml } from '../yaml.ts';
import type { YamlEntry, YamlNode } from '../yaml.ts';
import { findSecrets } from './secrets.ts';
import {
  DEFAULT_COMMIT_TEMPLATE,
  DEFAULT_FORBIDDEN,
  DEFAULT_PR_TEMPLATE,
  hasVersionToken,
  isTrailerTemplate,
  templateProblem,
} from './signature.ts';
import { insideProject, insideTrust, normalize, trustProblem } from './paths.ts';
import type { Mode, Position, Problem, Seat, TeamFile, ValidateResult } from './types.ts';

type MapNode = Extract<YamlNode, { kind: 'map' }>;
type Fields = Map<string, YamlEntry>;

const POSITIONS: Position[] = ['last-line', 'trailer', 'anywhere'];
const MODES: Mode[] = ['worktree', 'shared'];

// Validates the text of a team file. Every problem is collected, each with its line.
export function validateTeamFile(text: string): ValidateResult {
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, errors: [{ line: error.line, message: error.message }] };
    throw error;
  }
  const check = new Check();
  const secrets = findSecrets(root);
  check.problems.push(...secrets.refused);
  check.warnings.push(...secrets.warned);
  const team = readTeam(root, check);
  if (check.problems.length || !team) {
    return { ok: false, errors: check.problems.sort((a, b) => a.line - b.line) };
  }
  return { ok: true, team, warnings: check.warnings };
}

class Check {
  problems: Problem[] = [];
  warnings: Problem[] = [];

  fail(line: number, message: string): void {
    this.problems.push({ line, message });
  }

  // The fields of a map, with every field outside `known` reported.
  fields(node: YamlNode | undefined, where: string, known: string[]): Fields {
    const fields: Fields = new Map();
    if (!node) return fields;
    if (node.kind !== 'map') {
      if (!(node.kind === 'scalar' && node.value === null)) this.fail(node.line, `${where} must be a map of fields`);
      return fields;
    }
    for (const entry of node.entries) {
      if (known.includes(entry.key)) fields.set(entry.key, entry);
      else this.fail(entry.line, `unknown field "${entry.key}" in ${where}`);
    }
    return fields;
  }

  text(entry: YamlEntry | undefined, name: string): string | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'string' && node.value !== '') return node.value;
    this.fail(node.line, `${name} must be text${node.kind === 'scalar' && node.value !== null && node.value !== '' ? ': quote it' : ''}`);
    return undefined;
  }

  required(entry: YamlEntry | undefined, name: string, line: number): string | undefined {
    if (!entry) this.fail(line, `${name} is required`);
    return this.text(entry, name);
  }

  oneOf<T extends string>(entry: YamlEntry | undefined, name: string, values: T[]): T | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'string' && (values as string[]).includes(node.value)) {
      return node.value as T;
    }
    this.fail(node.line, `${name} must be one of: ${values.join(', ')}`);
    return undefined;
  }

  flag(entry: YamlEntry | undefined, name: string): boolean {
    if (!entry) return false;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'boolean' && !node.quoted) return node.value;
    this.fail(node.line, `${name} must be true or false`);
    return false;
  }

  whole(entry: YamlEntry | undefined, name: string, least: number): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'number' && Number.isInteger(node.value) && node.value >= least) {
      return node.value;
    }
    this.fail(node.line, `${name} must be a whole number, ${least} or more`);
    return undefined;
  }

  number(entry: YamlEntry | undefined, name: string): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind === 'scalar' && typeof node.value === 'number' && Number.isFinite(node.value) && node.value > 0) {
      return node.value;
    }
    this.fail(node.line, `${name} must be a number above 0`);
    return undefined;
  }

  // A value with its unit, such as 120s, 25% or 10GB.
  measure(entry: YamlEntry | undefined, name: string, units: Record<string, number>, example: string): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    const raw = node.kind === 'scalar' ? node.raw : '';
    const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z%]+)$/.exec(raw);
    const unit = match?.[2];
    if (match && unit !== undefined && unit in units && node.kind === 'scalar' && !node.quoted) {
      return Number(match[1]) * (units[unit] as number);
    }
    this.fail(node.line, `${name} needs a value with its unit (${Object.keys(units).join(', ')}), such as ${example}`);
    return undefined;
  }

  list(entry: YamlEntry | undefined, name: string): { value: string; line: number }[] {
    if (!entry) return [];
    const node = entry.value;
    if (node.kind !== 'seq') {
      if (!(node.kind === 'scalar' && node.value === null)) this.fail(node.line, `${name} must be a list`);
      return [];
    }
    const out: { value: string; line: number }[] = [];
    for (const item of node.items) {
      if (item.kind === 'scalar' && typeof item.value === 'string' && item.value !== '') {
        out.push({ value: item.value, line: item.line });
      } else {
        this.fail(item.line, `each item of ${name} must be text${item.kind === 'map' ? ': quote a line that contains ": "' : ''}`);
      }
    }
    return out;
  }
}

const DURATION = { s: 1, m: 60, h: 3600 };
const PERCENT = { '%': 1 };
const SIZE = { MB: 1e6, GB: 1e9, TB: 1e12 };

function readTeam(root: YamlNode, check: Check): TeamFile | null {
  if (root.kind !== 'map') {
    check.fail(root.line, 'the file must be a map of fields, starting with "format: 1"');
    return null;
  }
  const top = check.fields(root, 'the file', [
    'format', 'project', 'visibility', 'session', 'coordinator', 'operator', 'tools', 'identity', 'rules',
    'trust', 'workspace', 'watch', 'machine', 'limits', 'seats',
  ]);

  const format = top.get('format');
  if (!format) check.fail(1, 'format is required: "format: 1"');
  else if (!(format.value.kind === 'scalar' && format.value.value === 1 && !format.value.quoted)) {
    check.fail(format.line, 'format must be 1: this version of team reads no other');
  }

  const project = check.required(top.get('project'), 'project', 1) ?? '';
  if (project && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) {
    check.fail(top.get('project')?.line ?? 1, 'project must be a short name: letters, digits, ".", "_" and "-"');
  }
  const session = check.text(top.get('session'), 'session') ?? project;
  if (session === 'default') {
    check.fail(top.get('session')?.line ?? top.get('project')?.line ?? 1,
      'session can\'t be "default", herdr\'s own session: give the team a session of its own');
  }

  const identity = readIdentity(top.get('identity'), check);
  const declaredVisibility = check.oneOf(top.get('visibility'), 'visibility', ['public', 'private']);
  const visibility = declaredVisibility ?? (identity.forbiddenPublic.length ? 'public' : 'private');

  const trustItems = check.list(top.get('trust'), 'trust');
  for (const item of trustItems) {
    const problem = trustProblem(item.value);
    if (problem) check.fail(item.line, `trust: "${item.value}" ${problem}`);
  }
  const trust = trustItems.map((item) => item.value);

  const broken = new Set<string>();
  const seats = readSeats(top.get('seats'), check, trust, root.line, broken);
  const workspace = readWorkspace(top.get('workspace'), check, project, trust, seats, root.line);
  for (const seat of seats) seat.mode ??= workspace.mode;

  const coordinator = readLead(top.get('coordinator'), 'coordinator', seats, broken, check);
  const operator = readLead(top.get('operator'), 'operator', seats, broken, check);

  const limits = readLimits(top.get('limits'), check, seats.length);

  return {
    format: 1,
    project,
    visibility,
    session,
    coordinator,
    operator,
    tools: readTools(top.get('tools'), check),
    identity,
    rules: check.list(top.get('rules'), 'rules').map((item) => item.value),
    trust,
    workspace,
    watch: readWatch(top.get('watch'), check),
    machine: readMachine(top.get('machine'), check),
    limits,
    seats: seats as Seat[],
  };
}

function readTools(entry: YamlEntry | undefined, check: Check): TeamFile['tools'] {
  const tools: TeamFile['tools'] = {};
  if (!entry) return tools;
  if (entry.value.kind !== 'map') {
    check.fail(entry.value.line, 'tools must be a map: a name, then its kind and where it is');
    return tools;
  }
  for (const tool of entry.value.entries) {
    const fields: Record<string, string> = {};
    if (tool.value.kind !== 'map') {
      check.fail(tool.value.line, `tools.${tool.key} must be a map with a kind`);
      continue;
    }
    for (const field of tool.value.entries) {
      const value = check.text(field, `tools.${tool.key}.${field.key}`);
      if (value !== undefined) fields[field.key] = value;
    }
    if (!('kind' in fields)) check.fail(tool.line, `tools.${tool.key} needs a kind`);
    tools[tool.key] = fields;
  }
  return tools;
}

function readIdentity(entry: YamlEntry | undefined, check: Check): TeamFile['identity'] {
  const identity = check.fields(entry?.value, 'identity', ['signature', 'humans', 'since', 'forbidden', 'forbidden_public']);
  const signature = check.fields(identity.get('signature')?.value, 'identity.signature', ['template', 'commits', 'pull_requests']);
  const commits = check.fields(signature.get('commits')?.value, 'identity.signature.commits', ['template', 'position', 'exempt']);
  const prs = check.fields(signature.get('pull_requests')?.value, 'identity.signature.pull_requests', ['template', 'position', 'exempt']);

  const base = readTemplate(signature.get('template'), 'identity.signature.template', check) ?? DEFAULT_COMMIT_TEMPLATE;
  const commitTemplate = readTemplate(commits.get('template'), 'identity.signature.commits.template', check) ?? base;
  const prTemplate = readTemplate(prs.get('template'), 'identity.signature.pull_requests.template', check) ?? DEFAULT_PR_TEMPLATE;

  const commitPosition = check.oneOf(commits.get('position'), 'identity.signature.commits.position', POSITIONS) ?? 'trailer';
  const prPosition = check.oneOf(prs.get('position'), 'identity.signature.pull_requests.position', POSITIONS) ?? 'last-line';
  if (commitPosition === 'trailer' && !isTrailerTemplate(commitTemplate)) {
    const line = commits.get('position')?.line ?? commits.get('template')?.line ?? signature.get('template')?.line ?? entry?.line ?? 1;
    check.fail(line, 'position "trailer" needs a template git reads as a trailer: "<token>: <value>", the token without spaces');
  }

  const exemptEntry = commits.get('exempt');
  const exempt = exemptEntry ? check.list(exemptEntry, 'identity.signature.commits.exempt') : [{ value: 'merge', line: 0 }];
  for (const item of exempt) {
    if (item.value !== 'merge') check.fail(item.line, `exempt takes only "merge" in this version, found "${item.value}"`);
  }
  const prExempt = prs.get('exempt');
  if (prExempt) check.fail(prExempt.line, 'pull_requests has no exempt: it applies to commits only');

  const forbidden = readPatterns(identity.get('forbidden'), 'identity.forbidden', check);
  const forbiddenPublic = readPatterns(identity.get('forbidden_public'), 'identity.forbidden_public', check);

  return {
    signature: {
      commits: { template: commitTemplate, position: commitPosition, exempt: exempt.some((item) => item.value === 'merge') ? ['merge'] : [] },
      pullRequests: { template: prTemplate, position: prPosition },
    },
    humans: check.list(identity.get('humans'), 'identity.humans').map((item) => item.value),
    since: check.text(identity.get('since'), 'identity.since') ?? null,
    forbidden: [...DEFAULT_FORBIDDEN, ...forbidden.filter((pattern) => !DEFAULT_FORBIDDEN.includes(pattern))],
    forbiddenPublic,
  };
}

function readTemplate(entry: YamlEntry | undefined, name: string, check: Check): string | undefined {
  const template = check.text(entry, name);
  if (template === undefined || !entry) return undefined;
  const problem = templateProblem(template);
  if (problem) check.fail(entry.value.line, `${name}: ${problem}`);
  return template;
}

function readPatterns(entry: YamlEntry | undefined, name: string, check: Check): string[] {
  const out: string[] = [];
  for (const item of check.list(entry, name)) {
    try {
      new RegExp(item.value);
      out.push(item.value);
    } catch (error) {
      check.fail(item.line, `${name}: not a regular expression (${(error as Error).message})`);
    }
  }
  return out;
}

type DraftSeat = Omit<Seat, 'mode'> & { mode?: Mode };

// `broken` collects the names of seats left out for their own problems, so that a reference to
// one is not reported a second time.
function readSeats(entry: YamlEntry | undefined, check: Check, trust: string[], topLine: number, broken: Set<string>): DraftSeat[] {
  if (!entry) {
    check.fail(topLine, 'seats is required: at least the coordinator\'s and the operator\'s seat');
    return [];
  }
  if (entry.value.kind !== 'seq' || !entry.value.items.length) {
    check.fail(entry.value.line, 'seats must be a list with at least one seat');
    return [];
  }
  const seats: DraftSeat[] = [];
  for (const item of entry.value.items) {
    const fields = check.fields(item, 'a seat', [
      'role', 'name', 'cli', 'vendor', 'model', 'version', 'display', 'launch', 'cwd', 'label', 'mode',
      'parked', 'stopped', 'count',
    ]);
    if (item.kind !== 'map') continue;
    const line = item.line;
    const role = check.required(fields.get('role'), 'a seat\'s role', line);
    const name = check.required(fields.get('name'), 'a seat\'s name', line);
    const at = name ? `seat "${name}"` : 'a seat';
    if (name && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      check.fail(fields.get('name')?.line ?? line, `${at}: the name takes letters, digits, ".", "_" and "-"`);
    }
    if (!fields.get('cli')) check.fail(line, `${at}: cli is required`);
    const cli = check.oneOf(fields.get('cli'), `${at}: cli`, CLIS);
    const vendor = check.required(fields.get('vendor'), `${at}: vendor`, line);
    const model = check.required(fields.get('model'), `${at}: model`, line);
    const version = readVersion(fields.get('version'), at, line, check);
    const launch = check.required(fields.get('launch'), `${at}: launch`, line);
    const display = check.text(fields.get('display'), `${at}: display`) ?? (model && version ? `${model} ${version}` : undefined);
    if (display && version && fields.get('display') && !hasVersionToken(display, version)) {
      check.fail(fields.get('display')?.line ?? line, `${at}: display must contain the version "${version}" as a token of its own`);
    }
    const cwd = readCwd(fields.get('cwd'), at, trust, check);
    const mode = check.oneOf(fields.get('mode'), `${at}: mode`, MODES);
    const parked = check.flag(fields.get('parked'), `${at}: parked`);
    const stopped = check.flag(fields.get('stopped'), `${at}: stopped`);
    const count = check.whole(fields.get('count'), `${at}: count`, 1) ?? 1;
    const label = check.text(fields.get('label'), `${at}: label`);
    if (!role || !name || !cli || !vendor || !model || !version || !launch || !display) {
      if (name) broken.add(name);
      continue;
    }
    for (let instance = 1; instance <= count; instance++) {
      const suffix = instance === 1 ? '' : `-${instance}`;
      seats.push({
        role, cli, vendor, model, version, display, launch, cwd, parked, stopped, line,
        name: name + suffix,
        label: (label ?? name) + suffix,
        declared: name,
        count,
        instance,
        ...(mode ? { mode } : {}),
      });
    }
  }
  reportCollisions(seats, 'name', check);
  reportCollisions(seats, 'label', check);
  return seats;
}

function readVersion(entry: YamlEntry | undefined, at: string, line: number, check: Check): string | undefined {
  if (!entry) {
    check.fail(line, `${at}: version is required`);
    return undefined;
  }
  const node = entry.value;
  if (node.kind === 'scalar' && typeof node.value === 'string' && node.value !== '') return node.value;
  if (node.kind === 'scalar' && typeof node.value === 'number') {
    check.fail(node.line, `${at}: version must be quoted ("${node.raw}"): unquoted, YAML reads it as a number and 4.10 becomes 4.1`);
  } else check.fail(node.line, `${at}: version must be quoted text`);
  return undefined;
}

function readCwd(entry: YamlEntry | undefined, at: string, trust: string[], check: Check): string {
  const cwd = check.text(entry, `${at}: cwd`);
  if (cwd === undefined || !entry) return '.';
  if (cwd.startsWith('/') || cwd.startsWith('~') || /^[A-Za-z]:[\\/]/.test(cwd)) {
    check.fail(entry.value.line, `${at}: cwd must be relative to the project, never absolute and never "~"`);
    return '.';
  }
  const path = normalize(cwd);
  if (!insideProject(path) && !insideTrust(path, trust)) {
    check.fail(entry.value.line, `${at}: cwd "${cwd}" is outside the project and matches no trust path`);
  }
  return path;
}

function reportCollisions(seats: DraftSeat[], field: 'name' | 'label', check: Check): void {
  const seen = new Map<string, DraftSeat>();
  for (const seat of seats) {
    const first = seen.get(seat[field]);
    if (!first) seen.set(seat[field], seat);
    else if (first.line !== seat.line || first.instance === seat.instance) {
      check.fail(seat.line, `two seats have the ${field} "${seat[field]}" (the other is on line ${first.line}${first.count > 1 || seat.count > 1 ? ', after count is expanded' : ''})`);
    }
  }
}

function readLead(
  entry: YamlEntry | undefined, field: 'coordinator' | 'operator', seats: DraftSeat[], broken: Set<string>, check: Check,
): string {
  const name = check.required(entry, field, 1);
  if (!name || !entry) return '';
  const seat = seats.find((candidate) => candidate.name === name);
  const line = entry.value.line;
  if (!seat) {
    if (!broken.has(name)) check.fail(line, `${field} "${name}" names no declared seat`);
  }
  else if (seat.count > 1) check.fail(line, `${field} "${name}" can't be a seat with count`);
  else if (seat.parked) check.fail(line, `${field} "${name}" can't be a parked seat`);
  else if (seat.stopped) check.fail(line, `${field} "${name}" can't be a stopped seat`);
  return name;
}

function readWorkspace(
  entry: YamlEntry | undefined, check: Check, project: string, trust: string[], seats: DraftSeat[], topLine: number,
): TeamFile['workspace'] {
  const fields = check.fields(entry?.value, 'workspace', ['mode', 'path', 'branch', 'base', 'setup', 'remove', 'protected', 'limit']);
  const mode = check.oneOf(fields.get('mode'), 'workspace.mode', MODES) ?? 'worktree';
  const usesWorktrees = seats.some((seat) => (seat.mode ?? mode) === 'worktree');
  const line = entry?.line ?? topLine;

  const path = check.text(fields.get('path'), 'workspace.path') ?? null;
  const base = check.text(fields.get('base'), 'workspace.base') ?? null;
  if (usesWorktrees && !base) check.fail(line, 'workspace.base is required when a seat works in worktrees');
  if (usesWorktrees && !path) check.fail(line, 'workspace.path is required when a seat works in worktrees');
  if (path) {
    const at = fields.get('path')?.value.line ?? line;
    const problem = worktreePathProblem(path, project, trust);
    if (problem) check.fail(at, `workspace.path ${problem}`);
  }
  const protectedPaths = fields.get('protected') ? check.list(fields.get('protected'), 'workspace.protected').map((item) => item.value) : ['.'];

  return {
    mode,
    path,
    branch: check.text(fields.get('branch'), 'workspace.branch') ?? '{task}',
    base,
    setup: check.list(fields.get('setup'), 'workspace.setup').map((item) => item.value),
    remove: check.oneOf(fields.get('remove'), 'workspace.remove', ['on-merge', 'manual']) ?? 'on-merge',
    protected: protectedPaths,
    limit: check.whole(fields.get('limit'), 'workspace.limit', 1) ?? 8,
  };
}

// A worktree goes under a fixed folder of its own, and inside a trust path.
function worktreePathProblem(path: string, project: string, trust: string[]): string | null {
  if (path.startsWith('/') || path.startsWith('~')) return 'must be relative to the project';
  const segments = path.split('/').filter((segment) => segment && segment !== '.');
  const last = segments[segments.length - 1];
  if (last !== '{task}') return 'must end with the segment {task}';
  if (segments.slice(0, -1).some((segment) => segment.includes('{task}'))) return 'takes {task} only as its last segment';
  const folder = segments.slice(0, -1).map((segment) => segment.replaceAll('{repo}', project || 'project'));
  if (folder.every((segment) => segment === '..')) {
    return 'needs a fixed folder of its own before {task}: this one puts worktrees straight into the project or one of its parents';
  }
  const sample = normalize([...folder, 'task'].join('/'));
  if (!insideTrust(sample, trust)) return 'matches no trust pattern';
  return null;
}

function readWatch(entry: YamlEntry | undefined, check: Check): TeamFile['watch'] {
  const fields = check.fields(entry?.value, 'watch', [
    'interval', 'idle_first', 'idle_repeat', 'team_idle', 'nudge_wait', 'unsent_after', 'quota_marks',
  ]);
  const time = (name: string, fallback: number) =>
    check.measure(fields.get(name), `watch.${name}`, DURATION, '120s or 10m') ?? fallback;
  let quotaMarks = [50, 75, 90];
  const marks = fields.get('quota_marks');
  if (marks) {
    const node = marks.value;
    const numbers = node.kind === 'seq' ? node.items.map((item) => (item.kind === 'scalar' ? item.value : null)) : null;
    if (numbers && numbers.every((n): n is number => typeof n === 'number' && n > 0 && n <= 100)) quotaMarks = numbers;
    else check.fail(node.line, 'watch.quota_marks must be a list of percentages, such as [50, 75, 90]');
  }
  return {
    interval: time('interval', 120),
    idleFirst: time('idle_first', 600),
    idleRepeat: time('idle_repeat', 1200),
    teamIdle: time('team_idle', 600),
    nudgeWait: time('nudge_wait', 600),
    unsentAfter: time('unsent_after', 60),
    quotaMarks,
  };
}

function readMachine(entry: YamlEntry | undefined, check: Check): TeamFile['machine'] {
  const fields = check.fields(entry?.value, 'machine', ['load_start', 'load_max', 'memory_start', 'memory_min', 'disk_min']);
  return {
    loadStart: check.number(fields.get('load_start'), 'machine.load_start') ?? 3,
    loadMax: check.number(fields.get('load_max'), 'machine.load_max') ?? 6,
    memoryStart: check.measure(fields.get('memory_start'), 'machine.memory_start', PERCENT, '25%') ?? 25,
    memoryMin: check.measure(fields.get('memory_min'), 'machine.memory_min', PERCENT, '15%') ?? 15,
    diskMin: check.measure(fields.get('disk_min'), 'machine.disk_min', SIZE, '10GB') ?? 10e9,
  };
}

function readLimits(entry: YamlEntry | undefined, check: Check, declared: number): TeamFile['limits'] {
  const fields = check.fields(entry?.value, 'limits', ['seats', 'temporary', 'vendors']);
  const temporary = check.whole(fields.get('temporary'), 'limits.temporary', 0) ?? 2;
  const vendors: Record<string, number> = {};
  const vendorsEntry = fields.get('vendors');
  if (vendorsEntry) {
    const node = vendorsEntry.value as MapNode;
    if (node.kind !== 'map') check.fail(node.line, 'limits.vendors must be a map: a vendor, then its ceiling');
    else {
      for (const vendor of node.entries) {
        const ceiling = check.whole(vendor, `limits.vendors.${vendor.key}`, 0);
        if (ceiling !== undefined) vendors[vendor.key] = ceiling;
      }
    }
  }
  return {
    seats: check.whole(fields.get('seats'), 'limits.seats', 1) ?? declared + temporary,
    temporary,
    vendors,
  };
}
