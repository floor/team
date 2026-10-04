// The exit-code contract. `contract/exit-codes.json` lists every way a command ends.
// `docs/reference/exit-codes.md` is generated from that list.
//
// An exit site is a `return` of a number, a `process.exit` / `process.exitCode` of a number,
// or a `throw` that leaves a command. A conditional return (`return ready ? 0 : 1`) is one site
// with two codes. Each site carries one or more `// exit: <id>` comments, and each id is one
// row. Several ids belong on one return when that return is how several different failures
// leave: "the run was refused" is not a row, each refusal is. Markers, not source order: inserting
// a return must fail on the new site, and the rows above it must keep their ids.
//
// `process.exitCode = code` publishes the number `main` already returned, so it is not a second
// site. `process.exitCode = reportFailure(...)` publishes the number `reportFailure` returns;
// that return is the site.
//
//   bun scripts/exit-codes.ts --check
//   bun scripts/exit-codes.ts --write
//   bun scripts/exit-codes.ts --shared
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const contractPath = join(root, 'contract', 'exit-codes.json');
const pagePath = join(root, 'docs', 'reference', 'exit-codes.md');

export type ExitRow = {
  code: number;
  command: string;
  id: string;
  meaning: string;
  trigger: string;
};

type Contract = { format: 1; rows: ExitRow[] };

export type ExitSite = {
  codes: number[];
  command: string;
  file: string;
  ids: string[];
  line: number;
};

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MARKER = /\/\/\s*exit:\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)\s*$/;

const FILES: { command: string; file: string }[] = [
  { command: 'team', file: 'src/cli.ts' },
  { command: 'conformance-adapter', file: 'src/conformance/adapter.ts' },
  ...readdirSync(join(root, 'src', 'commands'))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ command: name.slice(0, -3), file: `src/commands/${name}` })),
];

export type CheckInput = {
  contractText?: string;
  files?: ReadonlyMap<string, string>;
  page?: string;
};

function textOf(file: string, files?: ReadonlyMap<string, string>): string {
  const over = files?.get(file);
  if (over !== undefined) return over;
  return readFileSync(join(root, file), 'utf8');
}

function sourceOf(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Numeric codes a return can end on, or null when the return is not an exit. */
function exitCodes(expression: ts.Expression): number[] | null {
  const expr = unwrap(expression);
  if (ts.isNumericLiteral(expr)) {
    const code = Number(expr.text);
    return Number.isInteger(code) ? [code] : null;
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return null;
  }
  if (!ts.isConditionalExpression(expr)) return null;
  const whenTrue = exitCodes(expr.whenTrue);
  const whenFalse = exitCodes(expr.whenFalse);
  if (!whenTrue || !whenFalse) return null;
  return [...new Set([...whenTrue, ...whenFalse])].sort((a, b) => a - b);
}

function markerIds(source: ts.SourceFile, ranges: readonly ts.CommentRange[]): string[] {
  const ids: string[] = [];
  for (const range of ranges) {
    const hit = MARKER.exec(source.text.slice(range.pos, range.end));
    if (hit?.[1]) ids.push(hit[1]);
  }
  return ids;
}

function attachedIds(source: ts.SourceFile, node: ts.Node): string[] {
  const start = node.getStart(source);
  const leading = commentsAbove(source.text, start);
  const trailing = ts.getTrailingCommentRanges(source.text, node.end) ?? [];
  return [...leading, ...markerIds(source, trailing)];
}

/** `// exit:` comments on the lines immediately above a statement. */
function commentsAbove(text: string, start: number): string[] {
  const ids: string[] = [];
  let lineEnd = start;
  while (lineEnd > 0 && text[lineEnd - 1] !== '\n') lineEnd--;
  let cursor = lineEnd;
  while (cursor > 0) {
    const prev = text.lastIndexOf('\n', cursor - 2);
    const line = text.slice(prev + 1, cursor - 1);
    if (line.trim() === '') {
      cursor = prev + 1;
      if (prev < 0) break;
      continue;
    }
    const hit = MARKER.exec(line);
    if (!hit?.[1]) break;
    ids.unshift(hit[1]);
    if (prev < 0) break;
    cursor = prev + 1;
  }
  return ids;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isProcess(expression: ts.Expression, name: string): boolean {
  const expr = unwrap(expression);
  return ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'process' && expr.name.text === name;
}

function callName(expression: ts.Expression): string | null {
  const expr = unwrap(expression);
  if (!ts.isCallExpression(expr)) return null;
  const called = unwrap(expr.expression);
  return ts.isIdentifier(called) ? called.text : null;
}

function numericArgument(expression: ts.Expression): number | null {
  const expr = unwrap(expression);
  if (!ts.isNumericLiteral(expr)) return null;
  const code = Number(expr.text);
  return Number.isInteger(code) ? code : null;
}

/** Every exit site in one command file. */
export function sitesIn(command: string, file: string, text: string): ExitSite[] {
  const source = sourceOf(file, text);
  const sites: ExitSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      const codes = exitCodes(node.expression);
      if (codes) {
        sites.push({ command, file, line: lineOf(source, node), codes, ids: attachedIds(source, node) });
      }
    }
    if (ts.isThrowStatement(node)) {
      sites.push({ command, file, line: lineOf(source, node), codes: [], ids: attachedIds(source, node) });
    }
    if (ts.isExpressionStatement(node)) {
      const expr = unwrap(node.expression);
      if (ts.isCallExpression(expr) && isProcess(expr.expression, 'exit')) {
        const code = expr.arguments[0] ? numericArgument(expr.arguments[0]) : null;
        if (code !== null) {
          sites.push({ command, file, line: lineOf(source, node), codes: [code], ids: attachedIds(source, node) });
        }
      }
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isProcess(expr.left, 'exitCode')
      ) {
        const code = numericArgument(expr.right);
        // A call such as reportFailure publishes that function's return. An identifier
        // publishes the code main already returned. Neither is its own outcome.
        if (code !== null && callName(expr.right) === null) {
          sites.push({ command, file, line: lineOf(source, node), codes: [code], ids: attachedIds(source, node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Codes `reportFailure` returns. A throw ends as one of those. */
function failureCodes(texts: ReadonlyMap<string, string>): number[] {
  const cli = texts.get('src/cli.ts');
  if (cli === undefined) return [1];
  const source = sourceOf('src/cli.ts', cli);
  const codes = new Set<number>();
  const visit = (node: ts.Node, inside: boolean): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'reportFailure') {
      node.forEachChild((child) => visit(child, true));
      return;
    }
    if (inside && ts.isReturnStatement(node) && node.expression) {
      for (const code of exitCodes(node.expression) ?? []) codes.add(code);
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(source, false);
  return codes.size ? [...codes].sort((a, b) => a - b) : [1];
}

function allMarkers(text: string): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = MARKER.exec(lines[i] ?? '');
    if (hit?.[1]) out.push({ id: hit[1], line: i + 1 });
  }
  return out;
}

export function exitSites(files?: ReadonlyMap<string, string>): ExitSite[] {
  const texts = new Map(FILES.map((item) => [item.file, textOf(item.file, files)]));
  const thrown = failureCodes(texts);
  const sites: ExitSite[] = [];
  for (const item of FILES) {
    const found = sitesIn(item.command, item.file, texts.get(item.file) ?? '');
    for (const site of found) {
      if (site.codes.length === 0) site.codes = [...thrown];
      sites.push(site);
    }
  }
  return sites;
}

function byRow(a: ExitRow, b: ExitRow): number {
  return a.command.localeCompare(b.command) || a.code - b.code || a.id.localeCompare(b.id);
}

export function render(rows: readonly ExitRow[]): string {
  const sorted = [...rows].sort(byRow);
  const lines = [
    '# Exit codes',
    '',
    'Each row is one way a command ends. `0` means the work finished, `1` means the command refused or a step failed, and `2` means the invocation or a file could not be read. One `return` can be several rows when several different failures leave through it. A thrown error ends as `1`.',
    '',
    '| Id | Command | Code | Meaning | Example |',
    '| --- | --- | --- | --- | --- |',
    ...sorted.map((row) => `| \`${row.id}\` | \`${row.command}\` | ${row.code} | ${row.meaning.replaceAll('|', '\\|')} | \`${row.trigger.replaceAll('|', '\\|')}\` |`),
    '',
  ];
  return lines.join('\n');
}

function canonical(contract: Contract): string {
  const rows = [...contract.rows].sort(byRow).map((row) => ({
    code: row.code,
    command: row.command,
    id: row.id,
    meaning: row.meaning,
    trigger: row.trigger,
  }));
  return `${JSON.stringify({ format: 1 as const, rows }, null, 2)}\n`;
}

export function loadContract(text = readFileSync(contractPath, 'utf8')): Contract {
  return JSON.parse(text) as Contract;
}

/**
 * Same failure under different codes, then the different failures that share a code
 * inside one command. Meanings match as written.
 */
export function sharedReport(rows: readonly ExitRow[]): string {
  const byMeaning = new Map<string, ExitRow[]>();
  for (const row of rows) {
    const list = byMeaning.get(row.meaning) ?? [];
    list.push(row);
    byMeaning.set(row.meaning, list);
  }
  const across: string[] = [];
  for (const meaning of [...byMeaning.keys()].sort()) {
    const group = byMeaning.get(meaning) ?? [];
    const codes = [...new Set(group.map((row) => row.code))];
    if (codes.length < 2) continue;
    const where = [...group].sort(byRow).map((row) => `${row.command} ${row.code}`);
    across.push(`- ${meaning}: ${where.join(', ')}`);
  }
  const within: string[] = [];
  const commands = [...new Set(rows.map((row) => row.command))].sort();
  for (const command of commands) {
    const codes = [...new Set(rows.filter((row) => row.command === command).map((row) => row.code))].sort((a, b) => a - b);
    for (const code of codes) {
      const meanings = [...new Set(rows
        .filter((row) => row.command === command && row.code === code)
        .sort(byRow)
        .map((row) => row.meaning))];
      if (meanings.length < 2) continue;
      within.push(`- ${command} ${code}: ${meanings.join('; ')}`);
    }
  }
  return [
    'Same failure, different codes:',
    ...(across.length ? across : ['- (none)']),
    '',
    'Within one command:',
    ...(within.length ? within : ['- (none)']),
    '',
  ].join('\n');
}

/** Empty when every exit site has its rows and the page matches. */
export function problems(input: CheckInput = {}): string[] {
  const contractText = input.contractText ?? readFileSync(contractPath, 'utf8');
  const page = input.page ?? readFileSync(pagePath, 'utf8');
  const out: string[] = [];
  let contract: Contract;
  try {
    contract = JSON.parse(contractText) as Contract;
  } catch (error) {
    return [`contract/exit-codes.json: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (contract.format !== 1) out.push('contract/exit-codes.json: format must be 1');
  if (!Array.isArray(contract.rows)) return [...out, 'contract/exit-codes.json: rows must be a list'];
  if (canonical(contract) !== contractText) out.push('contract/exit-codes.json: not in canonical order');

  const seen = new Set<string>();
  for (const row of contract.rows) {
    if (!row.id || !ID.test(row.id)) out.push(`contract/exit-codes.json: ${row.command} ${row.code} needs an id`);
    if (row.id && !row.id.startsWith(`${row.command}.`)) {
      out.push(`contract/exit-codes.json: ${row.id} does not start with ${row.command}.`);
    }
    if (seen.has(row.id)) out.push(`contract/exit-codes.json: ${row.id} is listed twice`);
    seen.add(row.id);
    if (!Number.isInteger(row.code) || row.code < 0) out.push(`contract/exit-codes.json: ${row.id} has a bad code`);
    if (!row.meaning || !row.trigger) out.push(`contract/exit-codes.json: ${row.id} needs a meaning and a trigger`);
  }
  if (render(contract.rows) !== page) out.push('docs/reference/exit-codes.md: differs from the contract');

  const known = new Set(FILES.map((item) => item.command));
  for (const row of contract.rows) {
    if (!known.has(row.command)) out.push(`contract/exit-codes.json: ${row.command} is not a command`);
  }

  const sites = exitSites(input.files);
  const claimed = new Map<string, { file: string; line: number }>();
  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    if (site.ids.length === 0) out.push(`${where}: exit site has no row`);
    for (const id of site.ids) {
      const prior = claimed.get(id);
      if (prior) out.push(`${where}: ${id} is also marked at ${prior.file}:${prior.line}`);
      else claimed.set(id, { file: site.file, line: site.line });
      const row = contract.rows.find((item) => item.id === id);
      if (!row) {
        out.push(`${where}: ${id} has no contract row`);
        continue;
      }
      if (row.command !== site.command) out.push(`${where}: ${id} is marked on ${site.command}, the row says ${row.command}`);
      if (!site.codes.includes(row.code)) {
        out.push(`${where}: ${id} says code ${row.code}, the site returns ${site.codes.join(' or ')}`);
      }
    }
    for (const code of site.codes) {
      const covers = site.ids.some((id) => contract.rows.some((row) => row.id === id && row.code === code));
      if (!covers) out.push(`${where}: returns ${code}, which no row of this site lists`);
    }
  }

  const texts = new Map(FILES.map((item) => [item.file, textOf(item.file, input.files)]));
  for (const item of FILES) {
    for (const marker of allMarkers(texts.get(item.file) ?? '')) {
      if (!claimed.has(marker.id)) out.push(`${item.file}:${marker.line}: ${marker.id} is not on an exit site`);
    }
  }
  for (const row of contract.rows) {
    if (row.id && !claimed.has(row.id)) out.push(`contract/exit-codes.json: ${row.id} has no exit site`);
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  const shared = process.argv.includes('--shared');
  if (!write && !check && !shared) {
    process.stderr.write('Usage: bun scripts/exit-codes.ts --check|--write|--shared\n');
    process.exitCode = 2;
    return;
  }
  const contract = loadContract();
  if (write) writeFileSync(pagePath, render(contract.rows));
  if (shared) process.stdout.write(sharedReport(contract.rows));
  if (check) {
    const found = problems();
    if (found.length) {
      process.stderr.write(`${found.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('exit-codes: ok\n');
  }
}

if (import.meta.main) main();
