// The capture coverage matrix: for each CLI and screen kind, how many conformance fixtures are
// real captures, how many are constructed, and how many no README mentions. Provenance is the
// fixture folders' READMEs — a bullet or paragraph whose own subject says the file was built,
// transcribed or not captured marks that subject constructed; under a Constructed heading the
// bullets need no marker. A fixture its README never names is undocumented, not real: the
// matrix decides which real captures get taken, so an unproven file must never count as one.
// A README's "Not produced" section names kinds no capture exists for, with the reason.
//
//   bun run coverage           prints the matrix
//   bun run coverage --json    writes contract/capture-coverage.json
//   bun run coverage --check   regenerates that file and fails on any difference, and fails
//                              while any manifest fixture is undocumented
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

/** What one README says: constructed and mentioned names, and kinds it says were not produced. */
function readOf(readme: string): { constructed: Set<string>; mentioned: Set<string>; notProduced: Map<Kind, string> } {
  const constructed = new Set<string>();
  const mentioned = new Set<string>();
  const notProduced = new Map<Kind, string>();
  let inConstructed = false;
  let inNotProduced = false;
  let bullet = false;
  let block: string[] = [];
  const flush = () => {
    if (block.length === 0) return;
    const text = block.join(' ');
    for (const name of backticked(text)) mentioned.add(name);
    const marker = MARKERS.exec(text);
    let subjects: string[] = [];
    if (marker) {
      // Only the names inside the marker's own sentence, before the marker: a block can name
      // the captures a test builds from in one sentence and say the built screens are
      // constructed in another, and those captures stay real.
      const before = text.slice(0, marker.index);
      const ends = [...before.matchAll(/[.?!](?=\s)/g)];
      const sentenceStart = ends.length === 0 ? 0 : (ends[ends.length - 1]?.index ?? 0) + 1;
      subjects = backticked(before.slice(sentenceStart));
    } else if (inConstructed && bullet) {
      // Under a Constructed heading the bullets need no marker of their own; their subject is
      // the names they lead with, or the first name when the bullet has no colon.
      const colon = text.indexOf(':');
      const names = backticked(text);
      subjects = colon === -1 ? names.slice(0, 1) : backticked(text.slice(0, colon));
    }
    for (const name of subjects) constructed.add(name);
    if (inNotProduced && /not produced/i.test(text)) {
      // A Not-produced bullet names the kind it is about (backticked or bare, before the
      // colon) and says why; the reason is the first clause after "not produced".
      const colon = text.indexOf(':');
      const lead = colon === -1 ? text : text.slice(0, colon);
      const plain = lead.replace(/`[^`]+`/g, ' ');
      const kinds = KINDS.filter((kind) => lead.includes(`\`${kind}\``) || new RegExp(`\\b${kind}\\b`).test(plain));
      const tail = colon === -1 ? '' : text.slice(colon + 1).trim();
      const stripped = tail.replace(/^not produced\s*[:,—-]?\s*/i, '');
      const cut = /[,;.—]/.exec(stripped);
      const reason = (cut ? stripped.slice(0, cut.index) : stripped).trim() || 'reason not stated';
      for (const kind of kinds) notProduced.set(kind, reason);
    }
    block = [];
  };
  for (const line of readme.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const title = heading[1] ?? '';
      inConstructed = /constructed/i.test(title);
      inNotProduced = /not produced/i.test(title);
      // A heading can name its own subject, as "Constructed: `permission-pinned.txt`".
      for (const name of backticked(title)) {
        mentioned.add(name);
        if (inConstructed) constructed.add(name);
      }
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
  return { constructed, mentioned, notProduced };
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

const cache = new Map<string, ReturnType<typeof readOf>>();
/** What the README governing this fixture says. */
function readFor(file: string): ReturnType<typeof readOf> {
  const readme = readmeOf(file);
  let read = cache.get(readme);
  if (!read) {
    read = readOf(readFileSync(readme, 'utf8'));
    cache.set(readme, read);
  }
  return read;
}

/** Constructed, real, or undocumented — by the fixture's folder's README. */
function provenanceOf(file: string): Provenance {
  const read = readFor(file);
  const name = file.split('/').at(-1) ?? '';
  if (read.constructed.has(name)) return 'constructed';
  return read.mentioned.has(name) ? 'capture' : 'undocumented';
}

type Provenance = 'capture' | 'constructed' | 'undocumented';
type Cell = { real: number; constructed: number; undocumented: number };

/** The whole matrix, from the manifest and the READMEs. */
function matrix(): {
  clis: string[];
  cells: Record<string, Record<Kind, Cell>>;
  notProduced: Record<string, Record<string, string>>;
  fixtures: { file: string; cli: string; kind: Kind; provenance: Provenance }[];
} {
  const manifest = JSON.parse(readFileSync(join(fixtures, 'conformance.json'), 'utf8')) as Manifest;
  const clis = [...new Set(manifest.screens.map((screen) => screen.cli))].sort();
  const cells: Record<string, Record<Kind, Cell>> = {};
  for (const cli of clis) {
    cells[cli] = Object.fromEntries(KINDS.map((kind) => [kind, { real: 0, constructed: 0, undocumented: 0 }])) as Record<Kind, Cell>;
  }
  const cellOf = (cli: string, kind: Kind): Cell => {
    const cell = cells[cli]?.[kind];
    if (cell === undefined) throw new Error(`${cli} ${kind}: no cell, which cannot happen here`);
    return cell;
  };
  // Why a kind was never captured, per CLI, from each governing README's Not-produced section.
  const reasons = new Map<string, Partial<Record<Kind, string>>>();
  const listed: { file: string; cli: string; kind: Kind; provenance: Provenance }[] = [];
  for (const screen of manifest.screens) {
    const kind = screen.classify as Kind;
    if (!KINDS.includes(kind)) throw new Error(`${screen.file}: classify says "${screen.classify}"`);
    const provenance = provenanceOf(screen.file);
    cellOf(screen.cli, kind)[provenance === 'capture' ? 'real' : provenance]++;
    listed.push({ file: screen.file, cli: screen.cli, kind, provenance });
    const cliReasons = reasons.get(screen.cli) ?? {};
    for (const [notKind, reason] of readFor(screen.file).notProduced) {
      if (cliReasons[notKind] === undefined) cliReasons[notKind] = reason;
    }
    reasons.set(screen.cli, cliReasons);
  }
  const notProduced: Record<string, Record<string, string>> = {};
  for (const cli of clis) {
    const source = reasons.get(cli) ?? {};
    const entry: Record<string, string> = {};
    for (const kind of KINDS) {
      const reason = source[kind];
      if (reason !== undefined) entry[kind] = reason;
    }
    notProduced[cli] = entry;
  }
  const byFile = (a: { file: string }, b: { file: string }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { clis, cells, notProduced, fixtures: listed.sort(byFile) };
}

/** The checked-in document, byte for byte: sorted, no dates, no paths but the fixtures' own. */
function document(): string {
  const { clis, cells, notProduced, fixtures } = matrix();
  return `${JSON.stringify({ kind: 'capture-coverage', clis, kinds: KINDS, cells, notProduced, fixtures }, null, 2)}\n`;
}

/** The matrix a person reads. */
function table(): string {
  const { clis, cells, notProduced } = matrix();
  const cellOf = (cli: string, kind: Kind): Cell => {
    const cell = cells[cli]?.[kind];
    if (cell === undefined) throw new Error(`${cli} ${kind}: no cell, which cannot happen here`);
    return cell;
  };
  const reasonOf = (cli: string, kind: Kind): string | undefined => notProduced[cli]?.[kind];
  const head = ['cli', 'kind', 'real', 'constructed', 'undocumented'];
  const rows: string[][] = [];
  const empty: string[] = [];
  for (const cli of clis) {
    for (const kind of KINDS) {
      const cell = cellOf(cli, kind);
      rows.push([cli, kind, String(cell.real), String(cell.constructed), String(cell.undocumented)]);
      if (cell.real === 0) {
        const note = cell.constructed > 0
          ? ' (constructed only)'
          : reasonOf(cli, kind) !== undefined
            ? ` (not produced: ${reasonOf(cli, kind)})`
            : ' (no fixtures)';
        empty.push(`${cli} ${kind}${note}`);
      }
    }
  }
  const widths = head.map((_, column) => Math.max(head[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)));
  const line = (row: string[]) => row.map((cell, at) => (cell ?? '').padEnd(widths[at] ?? 0)).join('  ').trimEnd();
  return `${[line(head), ...rows.map(line), '', `cells with no real capture: ${empty.length === 0 ? 'none' : empty.join(', ')}`].join('\n')}\n`;
}

/** The manifest fixtures no README names, by name, in manifest order. */
function undocumented(): string[] {
  return matrix()
    .fixtures.filter((fixture) => fixture.provenance === 'undocumented')
    .map((fixture) => fixture.file);
}

const mode = process.argv[2];
if (mode === '--json') {
  mkdirSync(join(root, 'contract'), { recursive: true });
  writeFileSync(outputFile, document());
  console.log('wrote contract/capture-coverage.json');
} else if (mode === '--check') {
  const stray = undocumented();
  if (stray.length > 0) {
    console.error(`no README mentions: ${stray.join(', ')}; name each fixture in its folder's README or remove it from the manifest`);
    process.exitCode = 1;
  } else if (!existsSync(outputFile)) {
    console.error('contract/capture-coverage.json is missing; run `bun run coverage --json`');
    process.exitCode = 1;
  } else if (document() !== readFileSync(outputFile, 'utf8')) {
    console.error('contract/capture-coverage.json is not current; run `bun run coverage --json`');
    process.exitCode = 1;
  } else {
    console.log('contract/capture-coverage.json is current');
  }
} else if (mode === undefined) {
  const stray = undocumented();
  process.stdout.write(table());
  if (stray.length > 0) process.stdout.write(`no README mentions: ${stray.join(', ')}\n`);
} else {
  console.error('Usage: bun scripts/coverage.ts [--json | --check]');
  process.exitCode = 2;
}
