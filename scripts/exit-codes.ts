// The exit-code contract. `contract/exit-codes.json` lists every code a command returns,
// with what it means and one way to trigger it. This script regenerates
// `docs/reference/exit-codes.md` from that list and fails when the page, the list, or the
// codes the commands actually return have drifted.
//
//   bun scripts/exit-codes.ts --check
//   bun scripts/exit-codes.ts --write
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const contractPath = join(root, 'contract', 'exit-codes.json');
const pagePath = join(root, 'docs', 'reference', 'exit-codes.md');

export type ExitRow = {
  code: number;
  command: string;
  meaning: string;
  trigger: string;
};

type Contract = { format: 1; rows: ExitRow[] };

const COMMANDS = join(root, 'src', 'commands');

/** The command a source file belongs to, or null when the file is not a command. */
export function commandOf(path: string): string | null {
  const file = path.split('/').pop() ?? path;
  if (file === 'cli.ts') return 'team';
  if (file === 'adapter.ts') return 'conformance-adapter';
  if (path.includes('/commands/') && file.endsWith('.ts')) return file.slice(0, -3);
  return null;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Arguments are not the returned code: `return read(pane, 200)` is not exit 200.
function withoutCalls(expr: string): string {
  let out = '';
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Every literal exit code in return statements and process.exit calls. */
export function codesOf(source: string): number[] {
  const text = stripComments(source);
  const codes = new Set<number>();
  for (const match of text.matchAll(/\breturn\b([^;\n]*)/g)) {
    const expr = withoutCalls(match[1] ?? '');
    for (const num of expr.matchAll(/(?:^|[\s?:|&,])([0-9]+)(?=[\s?:|&,]|$)/g)) {
      codes.add(Number(num[1]));
    }
  }
  for (const match of text.matchAll(/process\.exit(?:Code)?\s*(?:=\s*|\(\s*)([0-9]+)/g)) {
    codes.add(Number(match[1]));
  }
  return [...codes].sort((a, b) => a - b);
}

export function sources(): { command: string; path: string; text: string }[] {
  const files = [
    { command: 'team', path: join(root, 'src', 'cli.ts') },
    { command: 'conformance-adapter', path: join(root, 'src', 'conformance', 'adapter.ts') },
    ...readdirSync(COMMANDS)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => ({ command: name.slice(0, -3), path: join(COMMANDS, name) })),
  ];
  return files.map((file) => ({ ...file, text: readFileSync(file.path, 'utf8') }));
}

/** Codes the source returns that the contract does not list for this command. */
export function uncovered(command: string, source: string, rows: readonly ExitRow[]): number[] {
  const listed = new Set(rows.filter((row) => row.command === command).map((row) => row.code));
  return codesOf(source).filter((code) => !listed.has(code));
}

function byRow(a: ExitRow, b: ExitRow): number {
  return a.command.localeCompare(b.command) || a.code - b.code || a.meaning.localeCompare(b.meaning);
}

export function render(rows: readonly ExitRow[]): string {
  const sorted = [...rows].sort(byRow);
  const lines = [
    '# Exit codes',
    '',
    'Each command returns a code. `0` means the command did its work, `1` means it refused or a step failed, and `2` means the invocation or a file could not be read. One code can name more than one failure; each row is one failure and one way to trigger it.',
    '',
    '| Command | Code | Meaning | Example |',
    '| --- | --- | --- | --- |',
    ...sorted.map((row) => `| \`${row.command}\` | ${row.code} | ${row.meaning.replaceAll('|', '\\|')} | \`${row.trigger.replaceAll('|', '\\|')}\` |`),
    '',
  ];
  return lines.join('\n');
}

function canonical(contract: Contract): string {
  const rows = [...contract.rows].sort(byRow).map((row) => ({
    code: row.code,
    command: row.command,
    meaning: row.meaning,
    trigger: row.trigger,
  }));
  return `${JSON.stringify({ format: 1 as const, rows }, null, 2)}\n`;
}

export function loadContract(text = readFileSync(contractPath, 'utf8')): Contract {
  return JSON.parse(text) as Contract;
}

/** Empty when the contract, the page, and the commands agree. */
export function problems(contractText = readFileSync(contractPath, 'utf8'), page = readFileSync(pagePath, 'utf8')): string[] {
  const out: string[] = [];
  const contract = loadContract(contractText);
  if (contract.format !== 1) out.push('contract/exit-codes.json: format must be 1');
  if (canonical(contract) !== contractText) out.push('contract/exit-codes.json: not in canonical order');
  const seen = new Set<string>();
  for (const row of contract.rows) {
    const id = `${row.command}\t${row.code}\t${row.meaning}`;
    if (seen.has(id)) out.push(`contract/exit-codes.json: duplicate ${row.command} ${row.code} ${row.meaning}`);
    seen.add(id);
    if (!Number.isInteger(row.code) || row.code < 0) out.push(`contract/exit-codes.json: ${row.command} has a bad code`);
    if (!row.meaning || !row.trigger) out.push(`contract/exit-codes.json: ${row.command} ${row.code} needs a meaning and a trigger`);
  }
  if (render(contract.rows) !== page) out.push('docs/reference/exit-codes.md: differs from the contract');
  for (const source of sources()) {
    const extra = uncovered(source.command, source.text, contract.rows);
    for (const code of extra) out.push(`${source.command}: returns ${code}, which the contract does not list`);
    const scanned = new Set(codesOf(source.text));
    const listed = new Set(contract.rows.filter((row) => row.command === source.command).map((row) => row.code));
    if (listed.size === 0) out.push(`${source.command}: the contract lists no exit code`);
    for (const code of listed) {
      if (!scanned.has(code)) out.push(`${source.command}: the contract lists ${code}, which the command does not return`);
    }
  }
  const known = new Set(sources().map((source) => source.command));
  for (const row of contract.rows) {
    if (!known.has(row.command)) out.push(`contract/exit-codes.json: ${row.command} is not a command`);
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (!write && !check) {
    process.stderr.write('Usage: bun scripts/exit-codes.ts --check|--write\n');
    process.exitCode = 2;
    return;
  }
  const contract = loadContract();
  if (write) writeFileSync(pagePath, render(contract.rows));
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
