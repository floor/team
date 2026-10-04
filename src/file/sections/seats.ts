import { CLIS } from '../../clis.ts';
import type { YamlEntry } from '../../yaml.ts';
import { insideProject, insideTrust, normalize } from '../paths.ts';
import { hasVersionToken } from '../signature.ts';
import type { Check } from '../check.ts';
import type { Mode, Seat } from '../types.ts';
import type { Section } from './section.ts';
import { valueOf } from './section.ts';
import type { Budgeted } from './budgets.ts';
import { MODES } from './workspace.ts';

export type DraftSeat = Omit<Seat, 'mode'> & { mode?: Mode };

export const seats: Section = {
  name: 'seats',
  owner: false,
  after: ['trust', 'budgets'],
  validate(entry, ctx) {
    const trust = valueOf<string[]>(ctx, 'trust');
    const accounts = valueOf<Budgeted>(ctx, 'budgets').declared;
    return readSeats(entry, ctx.check, trust, ctx.root.line, ctx.broken, accounts);
  },
  schema: {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', minLength: 1 },
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
        cli: { enum: CLIS },
        vendor: { type: 'string', minLength: 1 },
        account: { type: 'string' },
        model: { type: 'string', minLength: 1 },
        version: { type: 'string', $comment: 'quoted: unquoted, YAML reads 4.10 as the number 4.1' },
        display: { type: 'string', $comment: 'defaults to "model version"; must contain the version as a token of its own' },
        launch: { type: 'string', minLength: 1 },
        cwd: { type: 'string', $comment: 'relative to the project, or a trust path' },
        label: { type: 'string' },
        mode: { enum: MODES },
        parked: { type: 'boolean' },
        stopped: { type: 'boolean' },
        count: { type: 'integer', minimum: 1 },
      },
      required: ['role', 'name', 'cli', 'vendor', 'model', 'version', 'launch'],
      $comment: 'account must name a key of budgets.accounts; label defaults to the model and version; a seat with count is neither lead',
    },
  },
};

// `broken` collects the names of seats left out for their own problems, so that a reference to
// one is not reported a second time. `accounts` is the names the file's budgets declare: a seat
// that names an `account:` must name one of these, or it would silently spend nothing budgeted.
function readSeats(
  entry: YamlEntry | undefined, check: Check, trust: string[], topLine: number, broken: Set<string>, accounts: ReadonlySet<string>,
): DraftSeat[] {
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
      'role', 'name', 'cli', 'vendor', 'account', 'model', 'version', 'display', 'launch', 'cwd', 'label', 'mode',
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
    // The account whose budget the seat spends, when the vendor's name is not it (§ 3b). Optional:
    // absent, the seat spends its vendor, and the fingerprint of every file written so far is
    // unchanged. Named, it must be one of the budgets' accounts: a typo would take the seat out of
    // every budget with no warning at all.
    const account = check.text(fields.get('account'), `${at}: account`);
    if (account !== undefined && !accounts.has(account)) {
      check.fail(fields.get('account')?.line ?? line, `${at}: account "${account}" is not in budgets.accounts`);
    }
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
    // Left out, the herdr title is the model and version. A written label wins, so a file that
    // already names one keeps the title, and the fingerprint, it had.
    if (!role || !name || !cli || !vendor || !model || !version || !launch || !display) {
      if (name) broken.add(name);
      continue;
    }
    for (let instance = 1; instance <= count; instance++) {
      const suffix = instance === 1 ? '' : `-${instance}`;
      seats.push({
        role, cli, vendor, model, version, display, launch, cwd, parked, stopped, line,
        name: name + suffix,
        label: (label ?? defaultLabel(model, version)) + suffix,
        declared: name,
        count,
        instance,
        ...(account ? { account } : {}),
        ...(mode ? { mode } : {}),
      });
    }
  }
  reportCollisions(seats, 'name', check);
  return seats;
}

export function defaultLabel(model: string, version: string): string {
  return `${model} ${version}`.toLowerCase();
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

function reportCollisions(seats: DraftSeat[], field: 'name', check: Check): void {
  const seen = new Map<string, DraftSeat>();
  for (const seat of seats) {
    const first = seen.get(seat[field]);
    if (!first) seen.set(seat[field], seat);
    else if (first.line !== seat.line || first.instance === seat.instance) {
      check.fail(seat.line, `two seats have the ${field} "${seat[field]}" (the other is on line ${first.line}${first.count > 1 || seat.count > 1 ? ', after count is expanded' : ''})`);
    }
  }
}
