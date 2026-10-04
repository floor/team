// The exit-code contract. `contract/exit-codes.json` lists every way a command ends.
// `docs/reference/exit-codes.md` is generated from that list.
//
// The gate keeps that list complete against ordinary changes to the commands (a new return, a
// new exit, a changed code). It reads the forms this codebase uses and refuses anything else.
// It is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic
// property name).
//
// A returned expression is a numeric literal with a marker, a conditional whose branches are
// both such, or an `await`/call of a function the gate has walked. That callee needs at least
// one return, and every path through it must end in a return or a throw. Type assertions and
// non-null assertions are looked through. A name declared as a function more than once in a
// file is not followed. In `src/cli.ts` the only `.default()` that is not itself an exit is
// `command.default`, where `command` is the awaited load from the `commands` table.
//
// Every `process.exit` and every write to `process.exitCode` under `src/` is scanned, including
// module scope. A numeric literal is a site and needs a marker. `process.exit()` with no
// argument, or a write that is not a literal, is an error. Two publishes are not sites:
// `process.exitCode = code` in the `.then` callback of `main`, and `process.exitCode =
// reportFailure(...)`.
//
// A `throw` with its own marker is a row. An unmarked `throw` a run function can reach outside
// a try that catches it is covered by `team.command-threw`.
//
//   bun scripts/exit-codes.ts --check
//   bun scripts/exit-codes.ts --write
//   bun scripts/exit-codes.ts --shared
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const UNREADABLE = "exit expression the contract can't read: return a marked literal or a covered call";

type ExitFunc = ts.FunctionLikeDeclaration;

export type CoveredThrow = { file: string; line: number; id: string };

export type Analysis = {
  coveredThrows: CoveredThrow[];
  sites: ExitSite[];
  unreadable: string[];
};

function isFunc(node: ts.Node): node is ExitFunc {
  return ts.isFunctionLike(node);
}

function unwrapExit(node: ts.Expression): ts.Expression {
  let current = unwrap(node);
  while (ts.isAwaitExpression(current)) current = unwrap(current.expression);
  return current;
}

/** Visit a function without entering nested functions. */
function visitOwn(fn: ts.Node, on: (node: ts.Node) => void): void {
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunc(node)) return;
    on(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
}

function insideCatchingTry(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (ts.isTryStatement(current) && current.catchClause) {
      const block = current.tryBlock;
      if (node.getStart() >= block.getStart() && node.getEnd() <= block.getEnd()) return true;
    }
    current = current.parent;
  }
  return false;
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec).replaceAll('\\', '/');
  return base.endsWith('.ts') ? base : `${base}.ts`;
}

function commandFor(file: string, inherited: string): string {
  return FILES.find((item) => item.file === file)?.command ?? inherited;
}

function filesUnderSrc(extra?: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.ts')) found.add(next);
    }
  };
  walk('src');
  if (extra) {
    for (const key of extra.keys()) {
      if (key.startsWith('src/') && key.endsWith('.ts')) found.add(key);
    }
  }
  return [...found].sort();
}

function bindingInit(fn: ts.Node, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  visitOwn(fn, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
    }
  });
  return found;
}

/** `command.default` only when `command` is the awaited load from the commands table. */
function isCommandDispatcher(expr: ts.Expression, fn: ts.Node): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const called = unwrap(expr.expression);
  if (!ts.isPropertyAccessExpression(called) || called.name.text !== 'default') return false;
  const recv = unwrap(called.expression);
  if (!ts.isIdentifier(recv)) return false;
  const loaded = bindingInit(fn, recv.text);
  if (!loaded) return false;
  const awaited = unwrapExit(loaded);
  if (!ts.isCallExpression(awaited)) return false;
  const callee = unwrap(awaited.expression);
  if (!ts.isIdentifier(callee)) return false;
  const loader = bindingInit(fn, callee.text);
  if (!loader) return false;
  const access = unwrap(loader);
  if (!ts.isElementAccessExpression(access)) return false;
  const table = unwrap(access.expression);
  return ts.isIdentifier(table) && table.text === 'commands';
}

/** The `.then` of `main` forwarding its code, or the call that publishes `reportFailure`. */
function isPublishedExitCode(expr: ts.BinaryExpression): boolean {
  if (callName(expr.right) === 'reportFailure') return true;
  const right = unwrap(expr.right);
  if (!ts.isIdentifier(right)) return false;
  let fn: ts.Node | undefined = expr.parent;
  while (fn && !isFunc(fn)) fn = fn.parent;
  if (!fn || !isFunc(fn)) return false;
  const param = fn.parameters[0];
  if (!param || !ts.isIdentifier(param.name) || param.name.text !== right.text) return false;
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== fn) return false;
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'then') return false;
  const recv = unwrap(callee.expression);
  if (!ts.isCallExpression(recv)) return false;
  const called = unwrap(recv.expression);
  return ts.isIdentifier(called) && called.text === 'main';
}

function alwaysCompletes(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isBlock(node)) {
    for (const stmt of node.statements) if (alwaysCompletes(stmt)) return true;
    return false;
  }
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isIfStatement(node)) {
    if (!node.elseStatement) return false;
    return alwaysCompletes(node.thenStatement) && alwaysCompletes(node.elseStatement);
  }
  if (ts.isTryStatement(node)) {
    if (node.finallyBlock && alwaysCompletes(node.finallyBlock)) return true;
    if (!alwaysCompletes(node.tryBlock)) return false;
    return node.catchClause ? alwaysCompletes(node.catchClause.block) : true;
  }
  if (ts.isSwitchStatement(node)) return switchCompletes(node);
  if (ts.isLabeledStatement(node)) return alwaysCompletes(node.statement);
  return false;
}

function switchCompletes(sw: ts.SwitchStatement): boolean {
  const clauses = sw.caseBlock.clauses;
  if (!clauses.some((clause) => ts.isDefaultClause(clause))) return false;
  let fallsInto = false;
  const exits: boolean[] = [];
  for (let i = clauses.length - 1; i >= 0; i--) {
    const clause = clauses[i];
    if (!clause) continue;
    let kind: 'exit' | 'break' | 'fall' = 'fall';
    for (const stmt of clause.statements) {
      if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
        kind = 'break';
        break;
      }
      if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) || alwaysCompletes(stmt)) {
        kind = 'exit';
        break;
      }
    }
    const exitsHere: boolean = kind === 'exit' || (kind === 'fall' && fallsInto);
    exits[i] = exitsHere;
    fallsInto = kind === 'break' ? false : exitsHere;
  }
  return exits.every(Boolean);
}

/** A followed callee has a return, and no path falls off its end. */
function returnsCovered(func: ExitFunc): boolean {
  if (ts.isArrowFunction(func) && func.body && !ts.isBlock(func.body)) return true;
  const body = func.body;
  if (!body || !ts.isBlock(body)) return false;
  if (ownReturns(func).length === 0) return false;
  return alwaysCompletes(body);
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

/**
 * The gate follows each returned call and requires that callee to be fully covered too.
 * A throw with no row of its own is covered by `team.command-threw`.
 */
export function analyze(files?: ReadonlyMap<string, string>): Analysis {
  const texts = new Map(FILES.map((item) => [item.file, textOf(item.file, files)]));
  const thrown = failureCodes(texts);
  const parsed = new Map<string, ts.SourceFile>();
  const named = new Map<string, Map<string, ExitFunc>>();
  const imported = new Map<string, Map<string, { file: string; exportName: string }>>();
  const sites: ExitSite[] = [];
  const unreadable: string[] = [];
  const coveredThrows: CoveredThrow[] = [];
  const returnSeen = new Set<string>();
  const throwSeen = new Set<string>();
  const counted = new Map<string, Map<string, number>>();

  function load(file: string): ts.SourceFile | null {
    const hit = parsed.get(file);
    if (hit) return hit;
    let text: string;
    try {
      text = textOf(file, files);
    } catch {
      return null;
    }
    const source = sourceOf(file, text);
    parsed.set(file, source);
    return source;
  }

  function functionsIn(source: ts.SourceFile): Map<string, ExitFunc> {
    const hit = named.get(source.fileName);
    if (hit) return hit;
    const map = new Map<string, ExitFunc>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && !map.has(node.name.text)) map.set(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        if (isFunc(init) && !map.has(node.name.text)) map.set(node.name.text, init);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    named.set(source.fileName, map);
    return map;
  }

  function moduleBindings(source: ts.SourceFile, file: string): Map<string, { file: string; exportName: string }> {
    const hit = imported.get(file);
    if (hit) return hit;
    const map = new Map<string, { file: string; exportName: string }>();
    for (const stmt of source.statements) {
      if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const target = resolveSpec(file, stmt.moduleSpecifier.text);
      const clause = stmt.importClause;
      if (!target || !clause) continue;
      if (clause.name) map.set(clause.name.text, { file: target, exportName: 'default' });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.isTypeOnly || !ts.isIdentifier(el.name)) continue;
          const exportName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
          map.set(el.name.text, { file: target, exportName });
        }
      }
    }
    imported.set(file, map);
    return map;
  }

  function dynamicBindings(fn: ts.Node, file: string): Map<string, { file: string; exportName: string }> {
    const map = new Map<string, { file: string; exportName: string }>();
    visitOwn(fn, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isObjectBindingPattern(node.name)) return;
      const init = unwrap(node.initializer);
      const awaited = ts.isAwaitExpression(init) ? unwrap(init.expression) : init;
      if (!ts.isCallExpression(awaited) || awaited.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
      const spec = awaited.arguments[0];
      if (!spec || !ts.isStringLiteral(spec)) return;
      const target = resolveSpec(file, spec.text);
      if (!target) return;
      for (const el of node.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const exportName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        map.set(el.name.text, { file: target, exportName });
      }
    });
    return map;
  }

  function exportedFunction(source: ts.SourceFile, name: string): ExitFunc | null {
    if (name !== 'default') return functionsIn(source).get(name) ?? null;
    for (const stmt of source.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.DefaultKeyword)) return stmt;
      if (!ts.isExportAssignment(stmt)) continue;
      const expr = unwrap(stmt.expression);
      if (isFunc(expr)) return expr;
      if (ts.isIdentifier(expr)) return functionsIn(source).get(expr.text) ?? null;
    }
    return null;
  }

  function loadExport(file: string, name: string): { file: string; func: ExitFunc } | null {
    const source = load(file);
    if (!source) return null;
    const func = exportedFunction(source, name);
    return func ? { file, func } : null;
  }

  function declarationCounts(source: ts.SourceFile): Map<string, number> {
    const hit = counted.get(source.fileName);
    if (hit) return hit;
    const counts = new Map<string, number>();
    const bump = (name: string): void => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) bump(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunc(unwrap(node.initializer))) {
        bump(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    counted.set(source.fileName, counts);
    return counts;
  }

  function resolveCall(call: ts.CallExpression, file: string, source: ts.SourceFile, fn: ts.Node): { file: string; func: ExitFunc } | null {
    const called = unwrap(call.expression);
    if (!ts.isIdentifier(called)) return null;
    if ((declarationCounts(source).get(called.text) ?? 0) > 1) return null;
    const local = functionsIn(source).get(called.text);
    if (local) return { file, func: local };
    const binding = moduleBindings(source, file).get(called.text) ?? dynamicBindings(fn, file).get(called.text);
    if (!binding) return null;
    return loadExport(binding.file, binding.exportName);
  }

  function reject(file: string, source: ts.SourceFile, node: ts.Node): void {
    unreadable.push(`${file}:${lineOf(source, node)}: ${UNREADABLE}`);
  }

  function classify(expr: ts.Expression, file: string, fn: ts.Node, at: ts.Node, command: string, fromArrow: boolean): void {
    const source = load(file);
    if (!source) return;
    const unwrapped = unwrapExit(expr);
    const codes = exitCodes(unwrapped);
    if (codes) {
      if (fromArrow) reject(file, source, at);
      else sites.push({ command, file, line: lineOf(source, at), codes, ids: attachedIds(source, at) });
      return;
    }
    if (ts.isConditionalExpression(unwrapped)) {
      classify(unwrapped.whenTrue, file, fn, at, command, fromArrow);
      classify(unwrapped.whenFalse, file, fn, at, command, fromArrow);
      return;
    }
    if (ts.isCallExpression(unwrapped)) {
      if (file === 'src/cli.ts' && isCommandDispatcher(unwrapped, fn)) return;
      const resolved = resolveCall(unwrapped, file, source, fn);
      if (!resolved) {
        reject(file, source, at);
        return;
      }
      walkReturns(resolved.file, resolved.func, commandFor(resolved.file, command));
      return;
    }
    reject(file, source, at);
  }

  function walkReturns(file: string, func: ExitFunc, command: string): void {
    const source = load(file);
    if (!source) return;
    const key = `${file}:${func.getStart(source)}`;
    if (returnSeen.has(key)) return;
    returnSeen.add(key);
    if (!returnsCovered(func)) reject(file, source, func);
    if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) classify(func.body, file, func, func.body, command, true);
    for (const ret of ownReturns(func)) {
      if (!ret.expression) {
        reject(file, source, ret);
        continue;
      }
      classify(ret.expression, file, func, ret, command, false);
    }
  }

  function scanExits(file: string): void {
    const source = load(file);
    if (!source) return;
    const command = commandFor(file, 'team');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isProcess(node.expression, 'exit')) {
        const arg = node.arguments[0];
        const code = arg ? numericArgument(arg) : null;
        if (arg && code !== null) {
          sites.push({ command, file, line: lineOf(source, node), codes: [code], ids: attachedIds(source, node) });
        } else {
          reject(file, source, node);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isProcess(node.left, 'exitCode') &&
        !isPublishedExitCode(node)
      ) {
        const code = numericArgument(node.right);
        if (code !== null && callName(node.right) === null) {
          sites.push({ command, file, line: lineOf(source, node), codes: [code], ids: attachedIds(source, node) });
        } else {
          reject(file, source, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  function walkThrows(file: string, func: ExitFunc, command: string): void {
    const source = load(file);
    if (!source) return;
    const key = `${file}:${func.getStart(source)}`;
    if (throwSeen.has(key)) return;
    throwSeen.add(key);
    const visit = (node: ts.Node): void => {
      if (node !== func && isFunc(node)) {
        walkThrows(file, node, command);
        return;
      }
      if (ts.isThrowStatement(node)) {
        const ids = attachedIds(source, node);
        if (ids.length === 0) {
          if (!insideCatchingTry(node)) coveredThrows.push({ file, line: lineOf(source, node), id: 'team.command-threw' });
        } else {
          sites.push({ command: commandFor(file, command), file, line: lineOf(source, node), codes: [...thrown], ids });
        }
      } else if (ts.isCallExpression(node) && !insideCatchingTry(node)) {
        const resolved = resolveCall(node, file, source, func);
        if (resolved) walkThrows(resolved.file, resolved.func, commandFor(resolved.file, command));
        for (const arg of node.arguments) {
          const value = unwrap(arg);
          if (isFunc(value)) walkThrows(file, value, command);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(func);
  }

  for (const item of FILES) {
    const source = load(item.file);
    if (!source) continue;
    const roots = item.file === 'src/cli.ts'
      ? [functionsIn(source).get('main'), functionsIn(source).get('reportFailure')]
      : [exportedFunction(source, 'default')];
    for (const func of roots) {
      if (!func) continue;
      walkReturns(item.file, func, item.command);
      walkThrows(item.file, func, item.command);
    }
  }
  for (const file of filesUnderSrc(files)) scanExits(file);

  coveredThrows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { sites, unreadable, coveredThrows };
}

function ownReturns(fn: ts.Node): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  visitOwn(fn, (node) => {
    if (ts.isReturnStatement(node)) out.push(node);
  });
  return out;
}

export function exitSites(files?: ReadonlyMap<string, string>): ExitSite[] {
  return analyze(files).sites;
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
    'The check keeps this list complete against ordinary changes to the commands (a new return, a new exit, a changed code); it reads the forms this codebase uses and refuses anything else; it is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic property name).',
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

  const analysis = analyze(input.files);
  for (const line of analysis.unreadable) out.push(line);
  const sites = analysis.sites;
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
