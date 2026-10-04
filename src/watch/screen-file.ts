// A profile file, in team's YAML subset, checked as it is loaded. The JSON Schema
// next to the profiles describes the same shape; this is what actually refuses a file,
// because the package does not carry a schema validator.
import { DialectError, compilePattern } from './dialect.ts';
import type { Composer, FallbackRule, LinePattern, Placeholder, Rule, ScreenData, Stage } from './screen-data.ts';
import type { Screen } from './screen.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';

const STAGES = ['unknown', 'trust', 'permission', 'question', 'working'] as const;
const KINDS = ['idle', 'working', 'unsent', 'permission', 'trust', 'question', 'unknown'] as const;
// The lines a dialog draws for its choices, built from their parts: the mark on the choice
// the cursor is on (claude-code ❯, codex ›, antigravity >) or the indent of the others, the
// number, and the labels the profiles' rules and fixtures show, run-on forms included — the
// trust dialog's "Yes, I trust this folder" and "No, exit", the permission dialog's "No, and
// tell Claude what to do differently" (escape hint and all), codex's "Yes, proceed (y)" and
// its own long No. The safety floor reads the first two numbered lines (screen-core's
// choiceLine and twoLine), so chrome must match none of them.
const CHOICE_MARKS = ['❯ ', '› ', '> ', '  '];
const CHOICE_TAILS = [
  '',
  ' Yes',
  ' No',
  ' Yes, I trust this folder',
  ' No, exit',
  ' No, and tell Claude what to do differently',
  ' No, and tell Claude what to do differently (esc)',
  ' Yes, proceed (y)',
  ' No, and tell Codex what to do differently (esc)',
];
const CHOICE_SAMPLES = CHOICE_MARKS.flatMap((mark) =>
  ['1', '2'].flatMap((number) => CHOICE_TAILS.map((tail) => `${mark}${number}.${tail}`)),
);

export function loadScreen(text: string): ScreenData {
  const root = parseYaml(text);
  const entries = mapping(root, 'a profile');
  // Launch keys are read by profile.ts. A screen-only snippet, as in the tests, omits them.
  only(entries, ['format', 'cli', 'screen', 'quota', 'binary', 'process_names', 'tested', 'unattended', 'rules', 'login', 'exit', 'timeouts', 'models', 'status_model']);
  const format = required(entries, 'format', root.line);
  if (format.value.kind !== 'scalar' || format.value.value !== 1) fail(format.line, '"format" must be 1');
  const cli = required(entries, 'cli', root.line);
  if (!stringOf(cli.value)) fail(cli.line, '"cli" must be a string');
  const screen = required(entries, 'screen', root.line);
  return screenOf(screen.value);
}

function screenOf(node: YamlNode): ScreenData {
  const entries = mapping(node, 'screen');
  only(entries, ['chrome', 'composer', ...STAGES]);
  const chrome = optional(entries, 'chrome');
  const composer = required(entries, 'composer', node.line);
  const data: ScreenData = {
    chrome: chrome ? chromeOf(chrome.value) : [],
    composer: composerOf(composer.value),
  };
  for (const name of STAGES) {
    const entry = optional(entries, name);
    if (entry) data[name] = stageOf(entry.value);
  }
  return data;
}

function stageOf(node: YamlNode): Stage {
  if (node.kind === 'seq') return { rules: node.items.map((item) => ruleOf(item, false)) };
  const entries = mapping(node, 'a stage');
  only(entries, ['ignore_case', 'rules']);
  const flag = optional(entries, 'ignore_case');
  const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
  const rules = required(entries, 'rules', node.line);
  if (rules.value.kind !== 'seq') fail(rules.line, '"rules" must be a list');
  return { rules: rules.value.items.map((item) => ruleOf(item, ignoreCase)) };
}

function ruleOf(node: YamlNode, ignoreCase: boolean): Rule {
  const entries = mapping(node, 'a rule');
  only(entries, ['any', 'all', 'footer', 'on_footer', 'below_last_rule', 'without_rule', 'none_after']);
  if (entries.length === 0) fail(node.line, 'a rule has no primitive');
  const rule: Rule = {};
  const any = optional(entries, 'any');
  const all = optional(entries, 'all');
  const footer = optional(entries, 'footer');
  const onFooter = optional(entries, 'on_footer');
  const below = optional(entries, 'below_last_rule');
  const withoutRule = optional(entries, 'without_rule');
  const noneAfter = optional(entries, 'none_after');
  if (any) rule.any = patternsOf(any.value, 'any', ignoreCase);
  if (all) rule.all = patternsOf(all.value, 'all', ignoreCase);
  if (footer) rule.footer = stringOf(footer.value) ?? fail(footer.line, '"footer" must be a string');
  if (onFooter) rule.onFooter = boolOf(onFooter.value, 'on_footer');
  if (below) rule.belowLastRule = patternOf(stringOf(below.value) ?? fail(below.line, '"below_last_rule" must be a string'), ignoreCase, below.line);
  if (withoutRule) rule.withoutRule = boolOf(withoutRule.value, 'without_rule');
  if (noneAfter) rule.noneAfter = noneAfterOf(noneAfter.value, ignoreCase);
  return rule;
}

function noneAfterOf(node: YamlNode, ignoreCase: boolean): NonNullable<Rule['noneAfter']> {
  const entries = mapping(node, 'none_after');
  only(entries, ['anchor', 'patterns']);
  const anchor = required(entries, 'anchor', node.line);
  const patterns = required(entries, 'patterns', node.line);
  return {
    anchor: linePattern(anchor.value, ignoreCase),
    patterns: patternsOf(patterns.value, 'patterns', ignoreCase),
  };
}

function patternsOf(node: YamlNode, key: string, ignoreCase: boolean): LinePattern[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, `"${key}" must be a non-empty list`);
  return node.items.map((item) => linePattern(item, ignoreCase));
}

// A pattern is a string, or a mapping with `match`, its optional `except` list and its
// own `ignore_case`. The pattern's flag is read with the stage's: a screen whose own
// case varies carries the flag beside the pattern, where a stage-wide flag would reach
// every rule. The flag is the entry's, so `except` is read on the same lines `match` is.
function linePattern(node: YamlNode, ignoreCase: boolean): LinePattern {
  if (node.kind === 'scalar') {
    const text = stringOf(node);
    if (text === null) fail(node.line, 'a pattern must be a string');
    return { match: patternOf(text, ignoreCase, node.line), except: [] };
  }
  const entries = mapping(node, 'a pattern');
  only(entries, ['match', 'except', 'ignore_case']);
  const match = required(entries, 'match', node.line);
  const text = stringOf(match.value);
  if (text === null) fail(match.line, '"match" must be a string');
  const flag = optional(entries, 'ignore_case');
  const own = flag ? boolOf(flag.value, 'ignore_case') : false;
  const except = optional(entries, 'except');
  return { match: patternOf(text, ignoreCase || own, match.line), except: except ? exceptOf(except.value, ignoreCase || own) : [] };
}

function exceptOf(node: YamlNode, ignoreCase: boolean): RegExp[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"except" must be a non-empty list');
  return node.items.map((item) => {
    const text = stringOf(item);
    if (text === null) fail(item.line, '"except" entries must be strings');
    return patternOf(text, ignoreCase, item.line);
  });
}

function composerOf(node: YamlNode): Composer {
  const entries = mapping(node, 'composer');
  const mode = required(entries, 'mode', node.line);
  const name = stringOf(mode.value);
  // How the CLI renders its greyed suggestions, read off the input line's styling. Optional:
  // a composer whose suggestions plain text already names needs none of it.
  const style = optional(entries, 'placeholder_style');
  const placeholderStyle = style ? placeholderStyleOf(style) : undefined;
  if (name === 'box-to-rule') {
    only(entries, ['mode', 'prompt', 'rule', 'footers', 'placeholders', 'placeholder_style']);
    const footers = optional(entries, 'footers');
    return {
      mode: name,
      prompt: regexField(entries, 'prompt', node.line),
      rule: regexField(entries, 'rule', node.line),
      footers: footers ? footersOf(footers, false) : [],
      placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value),
      placeholderStyle,
    };
  }
  if (name === 'status-last') {
    only(entries, ['mode', 'status_line', 'prompt', 'placeholders', 'placeholder_style']);
    return { mode: name, statusLine: regexField(entries, 'status_line', node.line), prompt: regexField(entries, 'prompt', node.line), placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value), placeholderStyle };
  }
  if (name === 'status-then-one') {
    only(entries, ['mode', 'status_line', 'prompt', 'placeholders', 'placeholder_style', 'strip_suffix', 'fallback']);
    const suffix = optional(entries, 'strip_suffix');
    const fallback = required(entries, 'fallback', node.line);
    return {
      mode: name,
      statusLine: regexField(entries, 'status_line', node.line),
      prompt: regexField(entries, 'prompt', node.line),
      placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value),
      placeholderStyle,
      stripSuffix: suffix ? composerString(suffix.value, 'strip_suffix', suffix.line) : null,
      fallback: fallbackOf(fallback.value),
    };
  }
  if (name === 'two-rules-footer-below') {
    only(entries, ['mode', 'ignore_case', 'prompt', 'rule', 'footers', 'placeholders', 'placeholder_style']);
    const flag = optional(entries, 'ignore_case');
    const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
    const footers = required(entries, 'footers', node.line);
    return {
      mode: name,
      prompt: regexField(entries, 'prompt', node.line, ignoreCase),
      rule: regexField(entries, 'rule', node.line, ignoreCase),
      footers: footersOf(footers, ignoreCase),
      placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value),
      placeholderStyle,
    };
  }
  fail(mode.line, `"mode" must be box-to-rule, status-last, status-then-one or two-rules-footer-below`);
}

function footersOf(entry: YamlEntry, ignoreCase: boolean): RegExp[] {
  if (entry.value.kind !== 'seq' || entry.value.items.length === 0) fail(entry.line, '"footers" must be a non-empty list');
  return entry.value.items.map((item) => composerString(item, 'footers', item.line, ignoreCase));
}

function placeholderStyleOf(entry: YamlEntry): 'dim' {
  const text = stringOf(entry.value);
  if (text !== 'dim') fail(entry.line, '"placeholder_style" must be dim');
  return text;
}

function fallbackOf(node: YamlNode): FallbackRule[] {
  if (node.kind !== 'seq') fail(node.line, '"fallback" must be a list');
  return node.items.map((item) => {
    const entries = mapping(item, 'a fallback rule');
    only(entries, ['all', 'kind']);
    const kind = required(entries, 'kind', item.line);
    const name = stringOf(kind.value);
    if (!name || !KINDS.includes(name as Screen['kind'])) fail(kind.line, '"kind" is not a screen kind');
    return { all: patternsOf(required(entries, 'all', item.line).value, 'all', false), kind: name as Screen['kind'] };
  });
}

function placeholdersOf(node: YamlNode): Placeholder[] {
  if (node.kind !== 'seq') fail(node.line, '"placeholders" must be a list');
  return node.items.map((item) => {
    const entries = mapping(item, 'a placeholder');
    only(entries, ['equals', 'prefix']);
    const equals = optional(entries, 'equals');
    const prefix = optional(entries, 'prefix');
    if (equals && prefix) fail(item.line, 'a placeholder is "equals" or "prefix", not both');
    if (equals) {
      const text = stringOf(equals.value);
      if (text === null) fail(equals.line, '"equals" must be a string');
      return { equals: text };
    }
    if (prefix) {
      const text = stringOf(prefix.value);
      if (!text) fail(prefix.line, '"prefix" must be a non-empty string');
      return { prefix: text };
    }
    fail(item.line, 'a placeholder needs "equals" or "prefix"');
  });
}

function chromeOf(node: YamlNode): RegExp[] {
  if (node.kind !== 'seq') fail(node.line, '"chrome" must be a list');
  return node.items.map((item) => {
    const text = stringOf(item);
    if (text === null) fail(item.line, '"chrome" entries must be strings');
    if (!anchored(text)) fail(item.line, 'a chrome pattern must match the whole line: "^…$"');
    const compiled = patternOf(text, false, item.line);
    if (CHOICE_SAMPLES.some((sample) => compiled.test(sample))) {
      fail(item.line, 'a chrome pattern would match a numbered choice line');
    }
    return compiled;
  });
}

function regexField(entries: YamlEntry[], key: string, line: number, ignoreCase = false): RegExp {
  const entry = required(entries, key, line);
  return composerString(entry.value, key, entry.line, ignoreCase);
}

// A composer key that reads a pattern string. The dialog shape aims its flag at the one
// line it sits on; a composer's own patterns — its prompt, rule, footers, status line,
// suffix — are strings, and the flag among them is refused in words that name the key.
function composerString(node: YamlNode, key: string, line: number, ignoreCase = false): RegExp {
  if (node.kind === 'map' && node.entries.some((item) => item.key === 'ignore_case')) {
    fail(line, `"${key}" cannot ignore case: only a dialog pattern may`);
  }
  const text = stringOf(node);
  if (text === null) fail(line, `"${key}" must be a string`);
  return patternOf(text, ignoreCase, line);
}

function patternOf(text: string, ignoreCase: boolean, line: number): RegExp {
  try {
    return compilePattern(text, ignoreCase);
  } catch (error) {
    if (error instanceof DialectError) fail(line, error.message);
    throw error;
  }
}

function anchored(text: string): boolean {
  if (!text.startsWith('^') || !text.endsWith('$')) return false;
  let slashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 0;
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

function stringOf(node: YamlNode): string | null {
  if (node.kind !== 'scalar' || typeof node.value !== 'string') return null;
  return node.value;
}

function boolOf(node: YamlNode, key: string): boolean {
  if (node.kind !== 'scalar' || typeof node.value !== 'boolean') fail(node.line, `"${key}" must be true or false`);
  return node.value;
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}
