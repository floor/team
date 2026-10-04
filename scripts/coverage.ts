// The capture coverage matrix: for each CLI and screen kind, how many conformance fixtures are
// real captures and how many are constructed. Provenance is the fixture folders' READMEs — a
// bullet or paragraph whose own subject says the file was built, transcribed or not captured
// marks that subject constructed; under a Constructed heading the bullets need no marker. Every
// other manifest fixture is a real capture.
//
//   bun run coverage           prints the matrix
//   bun run coverage --json    writes contract/capture-coverage.json
//   bun run coverage --check   regenerates that file and fails on any difference
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'fixtures');
const outputFile = join(root, 'contract', 'capture-coverage.json');

type ScreenCase = { file: string; cli: string; classify: string };
type Manifest = { screens: ScreenCase[] };

/** The kinds a screen is read as; the matrix's second axis. */
const KINDS = ['idle', 'working', 'unsent', 'permission', 'question', 'trust', 'unknown'] as const;
type Kind = (typeof KINDS)[number];

// What a README says of a fixture it did not capture from a pane. Matched against the block's
// own subject only: a capture's bullet may mention what another fixture was built from.
const MARKERS = /constructed|transcribed|reconstructed|not a capture|not captured|no CLI was started/i;

/** The backticked file names a piece of README text mentions, in order. */
function backticked(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const name = match[1] ?? '';
    if (/\.(txt|yaml)$/.test(name)) names.push(name);
  }
  return names;
}

/** The names one README marks as constructed. */
function constructedOf(readme: string): Set<string> {
  const constructed = new Set<string>();
  let inConstructed = false;
  let bullet = false;
  let block: string[] = [];
  const flush = () => {
    if (block.length === 0) return;
    const text = block.join(' ');
    const marker = MARKERS.exec(text);
    let subjects: string[] = [];
    if (marker) {
      // Only the names before the sentence that says the file was built: a marker bullet can
      // name the capture it was built from, and that capture stays real.
      subjects = backticked(text.slice(0, marker.index));
    } else if (inConstructed && bullet) {
      // Under a Constructed heading the bullets need no marker of their own; their subject is
      // the names they lead with.
      const colon = text.indexOf(':');
      subjects = colon === -1 ? [] : backticked(text.slice(0, colon));
    }
    for (const name of subjects) constructed.add(name);
    block = [];
  };
  for (const line of readme.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      inConstructed = /constructed/i.test(heading[1] ?? '');
      // A heading can name its own subject, as "Constructed: `permission-pinned.txt`".
      if (inConstructed) for (const name of backticked(heading[1] ?? '')) constructed.add(name);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      flush();
      bullet = true;
      block = [line];
      continue;
    }
    if (line.trim() === '') {
      flush();
      bullet = false;
      continue;
    }
    block.push(line);
  }
  flush();
  return constructed;
}

/** The deepest README governing a fixture: its own folder's, or the CLI's above it. */
function readmeOf(file: string): string {
  const parts = file.split('/');
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const candidate = join(fixtures, ...parts.slice(0, depth), 'README.md');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${file}: no README in its folder, so its provenance cannot be read`);
}

const cache = new Map<string, Set<string>>();
/** Whether the manifest names this fixture as constructed, by its folder's README. */
function isConstructed(file: string): boolean {
  const readme = readmeOf(file);
  let names = cache.get(readme);
  if (!names) {
    names = constructedOf(readFileSync(readme, 'utf8'));
    cache.set(readme, names);
  }
  return names.has(file.split('/').at(-1) ?? '');
}

type Provenance = 'capture' | 'constructed';
type Cell = { real: number; constructed: number };

/** The whole matrix, from the manifest and the READMEs. */
function matrix(): {
  clis: string[];
  cells: Record<string, Record<Kind, Cell>>;
  fixtures: { file: string; cli: string; kind: Kind; provenance: Provenance }[];
} {
  const manifest = JSON.parse(readFileSync(join(fixtures, 'conformance.json'), 'utf8')) as Manifest;
  const clis = [...new Set(manifest.screens.map((screen) => screen.cli))].sort();
  const cells: Record<string, Record<Kind, Cell>> = {};
  for (const cli of clis) {
    cells[cli] = Object.fromEntries(KINDS.map((kind) => [kind, { real: 0, constructed: 0 }])) as Record<Kind, Cell>;
  }
  const cellOf = (cli: string, kind: Kind): Cell => {
    const cell = cells[cli]?.[kind];
    if (cell === undefined) throw new Error(`${cli} ${kind}: no cell, which cannot happen here`);
    return cell;
  };
  const listed: { file: string; cli: string; kind: Kind; provenance: Provenance }[] = [];
  for (const screen of manifest.screens) {
    const kind = screen.classify as Kind;
    if (!KINDS.includes(kind)) throw new Error(`${screen.file}: classify says "${screen.classify}"`);
    const provenance: Provenance = isConstructed(screen.file) ? 'constructed' : 'capture';
    cellOf(screen.cli, kind)[provenance === 'capture' ? 'real' : 'constructed']++;
    listed.push({ file: screen.file, cli: screen.cli, kind, provenance });
  }
  const byFile = (a: { file: string }, b: { file: string }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { clis, cells, fixtures: listed.sort(byFile) };
}

/** The checked-in document, byte for byte: sorted, no dates, no paths but the fixtures' own. */
function document(): string {
  const { clis, cells, fixtures } = matrix();
  return `${JSON.stringify({ kind: 'capture-coverage', clis, kinds: KINDS, cells, fixtures }, null, 2)}\n`;
}

/** The matrix a person reads. */
function table(): string {
  const { clis, cells } = matrix();
  const cellOf = (cli: string, kind: Kind): Cell => {
    const cell = cells[cli]?.[kind];
    if (cell === undefined) throw new Error(`${cli} ${kind}: no cell, which cannot happen here`);
    return cell;
  };
  const head = ['cli', 'kind', 'real', 'constructed'];
  const rows: string[][] = [];
  const empty: string[] = [];
  for (const cli of clis) {
    for (const kind of KINDS) {
      const cell = cellOf(cli, kind);
      rows.push([cli, kind, String(cell.real), String(cell.constructed)]);
      if (cell.real === 0) empty.push(`${cli} ${kind}${cell.constructed === 0 ? ' (no fixtures)' : ' (constructed only)'}`);
    }
  }
  const widths = head.map((_, column) => Math.max(head[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)));
  const line = (row: string[]) => row.map((cell, at) => (cell ?? '').padEnd(widths[at] ?? 0)).join('  ').trimEnd();
  return `${[line(head), ...rows.map(line), '', `cells with no real capture: ${empty.length === 0 ? 'none' : empty.join(', ')}`].join('\n')}\n`;
}

const mode = process.argv[2];
if (mode === '--json') {
  mkdirSync(join(root, 'contract'), { recursive: true });
  writeFileSync(outputFile, document());
  console.log('wrote contract/capture-coverage.json');
} else if (mode === '--check') {
  if (!existsSync(outputFile)) {
    console.error('contract/capture-coverage.json is missing; run `bun run coverage --json`');
    process.exitCode = 1;
  } else if (document() !== readFileSync(outputFile, 'utf8')) {
    console.error('contract/capture-coverage.json is not current; run `bun run coverage --json`');
    process.exitCode = 1;
  } else {
    console.log('contract/capture-coverage.json is current');
  }
} else if (mode === undefined) {
  process.stdout.write(table());
} else {
  console.error('Usage: bun scripts/coverage.ts [--json | --check]');
  process.exitCode = 2;
}
