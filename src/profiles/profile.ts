// A launch profile, read from the CLI's YAML file. The screen is loaded separately.
import { readFileSync } from 'node:fs';
import { DialectError, compilePattern } from '../watch/dialect.ts';
import { WINDOWS, type QuotaPattern, type WindowName } from './quota.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';

/**
 * A launch profile: what `team` knows about one CLI, so a seat can't start
 * blocked. Keyed by the seat's `cli`.
 */
export interface Profile {
  cli: string;
  /** The CLI's process names, for the caller check. */
  processNames: readonly string[];
  /** The binary whose version `doctor` reads, with `--version`. */
  binary: string;
  /** The range this profile was tested with, both ends included. */
  tested: { from: string; to: string };
  /** Options that make the CLI run without approvals, added to the launch. */
  unattended: readonly string[];
  /** The option that carries the rules, or null when they go as a first message. */
  rulesOption: string | null;
  /** Arguments that exit 0 only when the owner is logged in, or null when the CLI has none. */
  loginCheck: readonly string[] | null;
  /** The command the owner runs to log in. */
  loginHint: string;
  /** What is typed into an idle prompt to make the CLI exit. */
  exit: string;
  /** Seconds to wait for the idle prompt after a launch. */
  idleTimeout: number;
  /** Seconds to wait for the pane's shell after the exit command. */
  exitTimeout: number;
  /** Whether the CLI starts on its last-used model when a launch names none. */
  lastUsedModel: boolean;
  /** The model and version a launch line's model id means, or null when unknown. */
  modelOf(launch: string): { model: string; version: string } | null;
  /** A launch that names no model starts on whatever model this CLI used last. */
  startsOnLastModel: boolean;
  /** The model flag, and the id this profile maps to that model and version, when it knows one. */
  modelFlag(model: string, version: string): { option: string; id: string | null };
}

/** A version as numbers: `2.1.288 (Claude Code)` is [2, 1, 288]. Null when the text holds none. */
export function parseVersion(text: string): number[] | null {
  const match = /\d+(?:\.\d+)*/.exec(text);
  return match ? match[0].split('.').map(Number) : null;
}

function order(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export type VersionVerdict = 'tested' | 'older' | 'newer' | 'unread';

/** Where a CLI's version sits against the range a profile was tested with. */
export function versionVerdict(text: string, tested: Profile['tested']): VersionVerdict {
  const version = parseVersion(text);
  const from = parseVersion(tested.from);
  const to = parseVersion(tested.to);
  if (!version || !from || !to) return 'unread';
  if (order(version, from) < 0) return 'older';
  if (order(version, to) > 0) return 'newer';
  return 'tested';
}

/** A word quoted for a POSIX shell. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a seat's pane runs: the unattended flag in its environment, the
 * file's launch line, then the profile's options and, where the CLI takes
 * them at launch, the rules.
 */
export function launchCommand(profile: Profile, launch: string, rules: string): string {
  const options = [...profile.unattended];
  if (profile.rulesOption !== null) options.push(profile.rulesOption, rules);
  return ['AGENT_UNATTENDED=1', launch.trim(), ...options.map(shellQuote)].join(' ');
}

type ModelRule = { match: RegExp; model: string; version: string; flag: string | null };

type Shipped = { profile: Profile; status: ModelRule[]; quota: QuotaPattern[] };

const NAMES = ['claude-code', 'codex', 'cursor', 'antigravity'] as const;
// The keys every profile carries. `status_model` and `last_used_model` are optional: a profile
// without the first belongs to a CLI whose screen doesn't show its model; the second says the
// CLI starts on its last-used model when a launch names none, and no shipped profile sets it.
const LAUNCH_KEYS = ['binary', 'process_names', 'tested', 'unattended', 'rules', 'login', 'exit', 'timeouts', 'models'] as const;
const OPTIONAL_LAUNCH_KEYS = ['status_model', 'last_used_model'] as const;

const SHIPPED: Record<string, Shipped> = loadShipped();

/** The profiles this version launches. A `cli` without one is reported and left out. */
export function profileFor(cli: string): Profile | null {
  return Object.hasOwn(SHIPPED, cli) ? (SHIPPED[cli]?.profile ?? null) : null;
}

/** The quota patterns shipped with a CLI. An unknown CLI, or one with none, has an empty list. */
export function quotaFor(cli: string): readonly QuotaPattern[] {
  return SHIPPED[cli]?.quota ?? [];
}

/** Patterns from a YAML list, for a profile snippet. A bad pattern throws. */
export function quotaPatterns(text: string): QuotaPattern[] {
  return quotaOf(parseYaml(text));
}

/** Quota patterns from a list already parsed. A bad pattern throws. */
export function quotaList(node: YamlNode): QuotaPattern[] {
  return quotaOf(node);
}

/** The model a status line names. `unreadable` is a line the rules claim that does not name one. */
export function statusOnLine(cli: string, line: string): { model: string; version: string } | 'unreadable' | null {
  const rules = SHIPPED[cli]?.status;
  if (!rules) return null;
  return apply(rules, line);
}

/**
 * One witness per `status_model` rule: a line built from the rule's pattern, with the declared
 * model's own words substituted into the capture the rule's templates name — and its version's,
 * when the seat has one. A rule whose shape cannot be written contributes none; a rule whose
 * templates cannot fill at all (their `"{n}"` names a group the pattern does not have — codex's
 * unreadable-line rule is exactly that) never can. The lines are evidence for the reader to
 * test, never a claim of their own: `canShowModel` runs each through `runningModel` and keeps
 * only the reading that comes back as exactly this model and version.
 */
export function statusWitnesses(cli: string, model: string, version: string | undefined): string[] {
  const rules = SHIPPED[cli]?.status;
  if (!rules) return [];
  const lines: string[] = [];
  for (const rule of rules) {
    const line = witnessOf(rule, model, version);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/**
 * A concrete line a pattern source accepts, when the walk can spell one — the same walk the
 * witness lines take, with no capture words to fill. This is how the frame's own lines are
 * written: the input row a placed read scans up to and the workspace line it needs below are
 * spelled from the profile's own expressions, never retyped beside them.
 */
export function patternWitness(source: string): string | null {
  try {
    return new WitnessLine(source, new Map<number, string>()).line();
  } catch {
    return null;
  }
}

function witnessOf(rule: ModelRule, model: string, version: string | undefined): string | null {
  const words = wordsFor(rule.model, model);
  if (words === null) return null;
  // The version template's words: the declared version, or one digit the capture's pattern
  // accepts when the seat has none — the reader is then asked about the model alone.
  const fromVersion = wordsFor(rule.version, version ?? '1');
  if (fromVersion === null) return null;
  for (const [group, text] of fromVersion) {
    const already = words.get(group);
    if (already !== undefined && already !== text) return null;
    words.set(group, text);
  }
  try {
    return new WitnessLine(rule.match.source, words).line();
  } catch {
    // A shape whose walk comes apart — never one the loader compiled, but the safe reading of
    // anything unread here is "no witness".
    return null;
  }
}

/**
 * The words a template pins to one capture, read from the text the file declares: the text
 * around the `"{n}"` must fit the template's literal parts, and what remains is the capture's.
 * A template with no hole (cursor's `Grok`) pins nothing — the round trip alone decides whether
 * the pattern's own literal is this model. Two holes in one template are refused: where the
 * declared text splits between them would be the pattern's to say.
 */
function wordsFor(template: string, text: string): Map<number, string> | null {
  const holes = [...template.matchAll(/\{(\d+)(?::title)?\}/g)];
  if (holes.length === 0) return new Map();
  if (holes.length > 1) return null;
  const hole = holes[0] as RegExpMatchArray;
  const at = hole.index ?? 0;
  const head = template.slice(0, at);
  const tail = template.slice(at + hole[0].length);
  if (text.length < head.length + tail.length || !text.startsWith(head) || !text.endsWith(tail)) return null;
  return new Map([[Number(hole[1]), text.slice(head.length, text.length - tail.length)]]);
}

// A character for each class, in this order: a space first — the whitespace classes the compiled
// sources spell out — then the letters and digits (a folded class like `[Gg]` needs its letter),
// then the punctuation the captured screens show. Any member does; the reader is the judge.
const WITNESS_CHARS = [
  ' ',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  '·', '-', '_', '.', '/', '|', '\t',
];

const WITNESS_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
const WITNESS_PUNCTUATION = '\\.^$|?*+()[]{}-/';

type WitnessItem = { text: string; hole: boolean };

/**
 * Writes one line from a compiled pattern, with each capture the templates name replaced by its
 * words. Every other atom is the smallest text the pattern accepts: a class gives one member, a
 * quantifier its lowest count, an alternation its first branch (every branch is still walked —
 * the captures after it are numbered past all of them, as `fill` reads them). A shape this
 * cannot write — a substituted capture under a quantifier, a class with no member to pick —
 * returns null, and the caller reads that as "no witness", never as a model.
 */
class WitnessLine {
  private at = 0;
  private groups = 0;
  private readonly placed = new Set<number>();
  private readonly source: string;
  private readonly words: Map<number, string>;

  constructor(source: string, words: Map<number, string>) {
    this.source = source;
    this.words = words;
  }

  /** The line, or null when the pattern's shape or the words refuse one. */
  line(): string | null {
    const top = this.alternation();
    if (top === null || this.at !== this.source.length) return null;
    // A hole the pattern has no capture for leaves its words nowhere to go: no line carries them.
    for (const group of this.words.keys()) if (!this.placed.has(group)) return null;
    return top.text;
  }

  private alternation(): WitnessItem | null {
    let chosen: WitnessItem | null = null;
    for (;;) {
      const branch = this.sequence();
      if (branch === null) return null;
      chosen ??= branch;
      if (this.source[this.at] !== '|') break;
      this.at++;
    }
    return chosen;
  }

  private sequence(): WitnessItem | null {
    let text = '';
    let hole = false;
    for (;;) {
      const ch = this.source[this.at];
      if (ch === undefined || ch === '|' || ch === ')') return { text, hole };
      const item = this.item();
      if (item === null) return null;
      text += item.text;
      hole = hole || item.hole;
    }
  }

  private item(): WitnessItem | null {
    const atom = this.atom();
    if (atom === null) return null;
    const count = this.quantifier();
    if (count === null) return null;
    if (count === undefined) return atom;
    // Repeating a substituted capture is not this rule's line: the capture would hold the last
    // repetition, and which one that is would be the builder's guess, not the reader's.
    if (atom.hole) return null;
    return { text: atom.text.repeat(count), hole: false };
  }

  private atom(): WitnessItem | null {
    const ch = this.source[this.at];
    if (ch === undefined) return null;
    if (ch === '(') return this.group();
    if (ch === '[') return this.classAtom();
    if (ch === '\\') return this.escape();
    if (ch === '^' || ch === '$') {
      this.at++;
      return { text: '', hole: false };
    }
    if (ch === '.') {
      this.at++;
      return { text: 'x', hole: false };
    }
    const cp = this.source.codePointAt(this.at);
    if (cp === undefined) return null;
    this.at += cp > 0xffff ? 2 : 1;
    return { text: String.fromCodePoint(cp), hole: false };
  }

  private group(): WitnessItem | null {
    this.at++;
    if (this.source[this.at] === '?') {
      if (this.source[this.at + 1] !== ':') return null;
      this.at += 2;
      const body = this.alternation();
      if (body === null || this.source[this.at] !== ')') return null;
      this.at++;
      return body;
    }
    const index = ++this.groups;
    const words = this.words.get(index);
    if (words !== undefined) {
      // The capture the words go in: its own shape is not written — the words are — so its body
      // is only walked, to number the captures inside it and to find its end.
      this.skipBody();
      this.placed.add(index);
      return { text: words, hole: true };
    }
    const body = this.alternation();
    if (body === null || this.source[this.at] !== ')') return null;
    this.at++;
    return body;
  }

  private skipBody(): void {
    let depth = 1;
    this.at++;
    while (this.at < this.source.length && depth > 0) {
      const ch = this.source[this.at];
      if (ch === '\\') {
        this.at += 2;
        continue;
      }
      if (ch === '[') {
        this.skipClass();
        continue;
      }
      if (ch === '(') {
        if (this.source[this.at + 1] !== '?') this.groups++;
        depth++;
        this.at++;
        continue;
      }
      if (ch === ')') depth--;
      this.at++;
    }
  }

  private skipClass(): void {
    this.at++;
    if (this.source[this.at] === '^') this.at++;
    while (this.at < this.source.length && this.source[this.at] !== ']') {
      if (this.source[this.at] === '\\') this.at++;
      this.at++;
    }
    this.at++;
  }

  private classAtom(): WitnessItem | null {
    const start = this.at;
    this.skipClass();
    const source = this.source.slice(start, this.at);
    for (const candidate of WITNESS_CHARS) {
      if (new RegExp(`^(?:${source})$`, 'u').test(candidate)) return { text: candidate, hole: false };
    }
    return null;
  }

  private escape(): WitnessItem | null {
    this.at++;
    const ch = this.source[this.at];
    if (ch === undefined) return null;
    if (ch === 'b') {
      this.at++;
      return { text: '', hole: false };
    }
    if (ch === 'u') return this.unicode();
    const simple = WITNESS_ESCAPES[ch] ?? (WITNESS_PUNCTUATION.includes(ch) ? ch : null);
    if (simple === null) return null;
    this.at++;
    return { text: simple, hole: false };
  }

  private unicode(): WitnessItem | null {
    if (this.source[this.at + 1] === '{') {
      const close = this.source.indexOf('}', this.at + 2);
      if (close < 0) return null;
      const hex = this.source.slice(this.at + 2, close);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
      this.at = close + 1;
      return { text: String.fromCodePoint(Number.parseInt(hex, 16)), hole: false };
    }
    const hex = this.source.slice(this.at + 1, this.at + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    this.at += 5;
    return { text: String.fromCodePoint(Number.parseInt(hex, 16)), hole: false };
  }

  private quantifier(): number | null | undefined {
    const ch = this.source[this.at];
    if (ch === '*') {
      this.at++;
      this.lazy();
      return 0;
    }
    if (ch === '+') {
      this.at++;
      this.lazy();
      return 1;
    }
    if (ch === '?') {
      this.at++;
      return 0;
    }
    if (ch !== '{') return undefined;
    const close = this.source.indexOf('}', this.at);
    if (close < 0) return null;
    const match = /^(\d+)(?:,(\d*))?$/.exec(this.source.slice(this.at + 1, close));
    if (!match) return null;
    this.at = close + 1;
    this.lazy();
    return Number(match[1]);
  }

  private lazy(): void {
    if (this.source[this.at] === '?') this.at++;
  }
}

function loadShipped(): Record<string, Shipped> {
  const out: Record<string, Shipped> = {};
  for (const name of NAMES) {
    const text = readFileSync(new URL(`./${name}.yaml`, import.meta.url), 'utf8');
    const shipped = launchOf(parseYaml(text));
    if (out[shipped.profile.cli]) fail(1, `two profiles are named "${shipped.profile.cli}"`);
    out[shipped.profile.cli] = shipped;
  }
  return out;
}

function launchOf(root: YamlNode): Shipped {
  const entries = mapping(root, 'a profile');
  const format = required(entries, 'format', root.line);
  if (format.value.kind !== 'scalar' || format.value.value !== 1) fail(format.line, '"format" must be 1');
  only(entries, ['format', 'cli', 'screen', 'screen_module', 'quota', ...LAUNCH_KEYS, ...OPTIONAL_LAUNCH_KEYS]);
  const cli = text(required(entries, 'cli', root.line), 'cli');
  required(entries, 'screen', root.line);
  const quotaEntry = optional(entries, 'quota');
  const statusEntry = optional(entries, 'status_model');
  const lastUsedEntry = optional(entries, 'last_used_model');
  for (const key of LAUNCH_KEYS) required(entries, key, root.line);
  const login = loginOf(required(entries, 'login', root.line).value);
  const timeouts = required(entries, 'timeouts', root.line).value;
  const models = modelsOf(required(entries, 'models', root.line).value);
  return {
    profile: {
      cli,
      binary: text(required(entries, 'binary', root.line), 'binary'),
      processNames: strings(required(entries, 'process_names', root.line).value, 'process_names'),
      tested: testedOf(required(entries, 'tested', root.line).value),
      unattended: strings(required(entries, 'unattended', root.line).value, 'unattended'),
      rulesOption: rulesOf(required(entries, 'rules', root.line).value),
      loginCheck: login.check,
      loginHint: login.hint,
      exit: text(required(entries, 'exit', root.line), 'exit'),
      idleTimeout: seconds(timeouts, 'idle'),
      exitTimeout: seconds(timeouts, 'exit'),
      lastUsedModel: lastUsedEntry ? boolOf(lastUsedEntry.value, 'last_used_model') : false,
      modelOf: (launch) => modelOf(models, launch),
      startsOnLastModel: models.absent === 'last-used',
      modelFlag: (model, version) => ({
        option: models.option[0] ?? '--model',
        id: suggestId(models.ids, model, version),
      }),
    },
    status: statusEntry ? modelRules(statusEntry.value, 'status_model') : [],
    quota: quotaEntry ? quotaOf(quotaEntry.value) : [],
  };
}

function quotaOf(node: YamlNode): QuotaPattern[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"quota" must be a non-empty list');
  return node.items.map((item) => {
    const entries = mapping(item, 'a quota pattern');
    only(entries, ['account', 'match', 'left', 'used', 'resets', 'window']);
    const left = optional(entries, 'left');
    const used = optional(entries, 'used');
    if (left && used) fail(left.line, 'a quota pattern has left or used, not both');
    if (!left && !used) fail(item.line, 'a quota pattern needs left or used');
    const side = left ? 'left' : 'used';
    const figure = text((left ?? used) as YamlEntry, side);
    template(figure, (left ?? used)?.line ?? item.line);
    const resetsEntry = optional(entries, 'resets');
    const resets = resetsEntry ? text(resetsEntry, 'resets') : null;
    if (resets !== null) template(resets, resetsEntry?.line ?? item.line);
    const window = text(required(entries, 'window', item.line), 'window');
    if (!(WINDOWS as readonly string[]).includes(window)) fail(item.line, '"window" must be session, daily or weekly');
    const match = required(entries, 'match', item.line);
    return {
      account: text(required(entries, 'account', item.line), 'account'),
      window: window as WindowName,
      match: pattern(text(match, 'match'), false, match.line),
      side,
      figure,
      resets,
    };
  });
}

// The flag's value is the next token, after "=" or any whitespace. The last flag in the line wins.
function modelOf(models: { option: string[]; ids: ModelRule[] }, launch: string): { model: string; version: string } | null {
  let bestAt = -1;
  let id: string | null = null;
  for (const option of models.option) {
    const found = flagValue(launch, option);
    if (found && found.at > bestAt) {
      bestAt = found.at;
      id = found.id;
    }
  }
  if (id === null) return null;
  const hit = apply(models.ids, id);
  return hit === 'unreadable' ? null : hit;
}

function flagValue(launch: string, option: string): { at: number; id: string } | null {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(\\S+)`, 'gu');
  let found: { at: number; id: string } | null = null;
  for (const match of launch.matchAll(pattern)) {
    if (match[1] === undefined || match.index === undefined) continue;
    found = { at: match.index, id: match[1] };
  }
  return found;
}

function apply(rules: ModelRule[], text: string): { model: string; version: string } | 'unreadable' | null {
  for (const rule of rules) {
    const match = rule.match.exec(text);
    if (!match) continue;
    const model = fill(rule.model, match);
    const version = fill(rule.version, match);
    // A match that cannot fill its template is a line of this shape that names no model.
    if (model === null || version === null) return 'unreadable';
    return { model, version };
  }
  return null;
}

function fill(template: string, match: RegExpMatchArray): string | null {
  let missing = false;
  const out = template.replace(/\{(\d+)(?::(title))?\}/g, (_whole, number: string, mode: string | undefined) => {
    const value = match[Number(number)];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return mode === 'title' ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : value;
  });
  return missing ? null : out;
}

function modelsOf(node: YamlNode): { option: string[]; ids: ModelRule[]; absent: string | null } {
  const entries = mapping(node, 'models');
  only(entries, ['option', 'ids', 'absent']);
  const absentEntry = optional(entries, 'absent');
  const absent = absentEntry ? text(absentEntry, 'absent') : null;
  if (absent !== null && absent !== 'last-used') fail(absentEntry?.line ?? node.line, '"absent" must be last-used');
  return {
    option: strings(required(entries, 'option', node.line).value, 'option'),
    ids: modelRules(required(entries, 'ids', node.line).value, 'ids'),
    absent,
  };
}

// The id a rule suggests for a declared model and version. A literal version suggests its flag
// only for that version; `{version}` in the flag is the seat's version. A model the rules do not
// name has no id, and the caller says so rather than guess one.
function suggestId(rules: ModelRule[], model: string, version: string): string | null {
  for (const rule of rules) {
    if (rule.flag === null || rule.model.includes('{') || rule.model !== model) continue;
    if (!rule.version.includes('{')) {
      if (rule.version !== version) continue;
      return rule.flag.replaceAll('{version}', version);
    }
    if (rule.flag.includes('{version}')) return rule.flag.replaceAll('{version}', version);
  }
  return null;
}

function modelRules(node: YamlNode, key: string): ModelRule[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, `"${key}" must be a non-empty list`);
  return node.items.map((item) => {
    const entries = mapping(item, 'a model rule');
    only(entries, ['match', 'ignore_case', 'model', 'version', 'flag']);
    const flag = optional(entries, 'ignore_case');
    const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
    const match = required(entries, 'match', item.line);
    const model = text(required(entries, 'model', item.line), 'model');
    const version = text(required(entries, 'version', item.line), 'version');
    template(model, match.line);
    template(version, match.line);
    const suggested = optional(entries, 'flag');
    const suggestedId = suggested ? text(suggested, 'flag') : null;
    if (suggested !== undefined && suggestedId !== null) {
      const rest = suggestedId.replaceAll('{version}', '');
      if (rest.includes('{') || rest.includes('}')) fail(suggested.line, 'a flag template is "{version}"');
    }
    return { match: pattern(text(match, 'match'), ignoreCase, match.line), model, version, flag: suggestedId };
  });
}

function template(text: string, line: number): void {
  const rest = text.replace(/\{(\d+)(?::title)?\}/g, '');
  if (rest.includes('{') || rest.includes('}')) fail(line, 'a template is "{n}" or "{n:title}"');
}

function rulesOf(node: YamlNode): string | null {
  if (node.kind === 'scalar' && node.value === 'first-message') return null;
  const entries = mapping(node, 'rules');
  only(entries, ['option']);
  return text(required(entries, 'option', node.line), 'option');
}

function loginOf(node: YamlNode): { check: string[]; hint: string } {
  const entries = mapping(node, 'login');
  only(entries, ['check', 'hint']);
  return {
    check: strings(required(entries, 'check', node.line).value, 'check'),
    hint: text(required(entries, 'hint', node.line), 'hint'),
  };
}

function testedOf(node: YamlNode): { from: string; to: string } {
  const entries = mapping(node, 'tested');
  only(entries, ['from', 'to']);
  return { from: text(required(entries, 'from', node.line), 'from'), to: text(required(entries, 'to', node.line), 'to') };
}

function seconds(node: YamlNode, key: string): number {
  const entries = mapping(node, 'timeouts');
  only(entries, ['idle', 'exit']);
  const value = text(required(entries, key, node.line), key);
  const match = /^([0-9]+)s$/.exec(value);
  if (!match || match[1] === undefined) fail(node.line, `"${key}" is a number of seconds, written "90s"`);
  return Number(match[1]);
}

function pattern(source: string, ignoreCase: boolean, line: number): RegExp {
  try {
    return compilePattern(source, ignoreCase);
  } catch (error) {
    if (error instanceof DialectError) fail(line, error.message);
    throw error;
  }
}

function strings(node: YamlNode, key: string): string[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, `"${key}" must be a non-empty list`);
  return node.items.map((item) => {
    const value = stringOf(item);
    if (!value) fail(item.line, `"${key}" entries must be non-empty strings`);
    return value;
  });
}

function text(entry: YamlEntry, key: string): string {
  const value = stringOf(entry.value);
  if (!value) fail(entry.line, `"${key}" must be a non-empty string`);
  return value;
}

function boolOf(node: YamlNode, key: string): boolean {
  if (node.kind !== 'scalar' || typeof node.value !== 'boolean') fail(node.line, `"${key}" must be true or false`);
  return node.value;
}

function stringOf(node: YamlNode): string | null {
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') return null;
  return node.value;
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}
