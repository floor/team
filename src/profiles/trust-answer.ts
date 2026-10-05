import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSgr } from '../ansi.ts';
import { YamlError, type YamlEntry, type YamlNode } from '../yaml.ts';
/** How a trust dialog shows the one folder it will trust. */
export type Extract = {
  after: string;
  before: string | null;
  untilBlank: boolean;
  join: boolean;
  box: boolean;
  refuseLine: string | null;
};

/**
 * One trust-answer record. Eligible only when `lobbyEvidence` names a fixture the
 * conformance manifest registers as a capture. The bytes are one hex byte.
 */
export type TrustRecord = {
  from: string;
  to: string;
  label: string;
  mark: string | null;
  footer: string | null;
  action: string;
  lobbyEvidence: string | null;
  extract: Extract;
};

const KEYS = ['1', 'a', 'enter'] as const;

/** The herdr key name for one recorded byte, or null when this version does not send it. */
export function keyOf(action: string): (typeof KEYS)[number] | null {
  if (!/^[0-9a-fA-F]{2}$/.test(action)) return null;
  const byte = Number.parseInt(action, 16);
  if (byte === 0x31) return '1';
  if (byte === 0x61) return 'a';
  if (byte === 0x0d) return 'enter';
  return null;
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}

function text(entry: YamlEntry, key: string): string {
  const node = entry.value;
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') {
    fail(entry.line, `"${key}" must be a non-empty string`);
  }
  return node.value;
}

function flag(entry: YamlEntry | undefined, key: string): boolean {
  if (!entry) return false;
  const node = entry.value;
  if (node.kind === 'scalar' && typeof node.value === 'boolean' && !node.quoted) return node.value;
  fail(node.line, `"${key}" must be true or false`);
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

/** The records a profile lists, or none. A profile that omits the key answers nothing. */
export function trustAnswers(entry: YamlEntry | undefined): TrustRecord[] {
  if (!entry) return [];
  const node = entry.value;
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"trust_answer" must be a non-empty list');
  return node.items.map((item) => recordOf(item));
}

function recordOf(node: YamlNode): TrustRecord {
  const entries = mapping(node, 'a trust answer');
  only(entries, ['from', 'to', 'label', 'mark', 'footer', 'action', 'lobby_evidence', 'extract']);
  const action = text(required(entries, 'action', node.line), 'action');
  if (!/^[0-9a-fA-F]{2}$/.test(action)) fail(required(entries, 'action', node.line).line, '"action" must be one hex byte');
  const evidence = optional(entries, 'lobby_evidence');
  return {
    from: text(required(entries, 'from', node.line), 'from'),
    to: text(required(entries, 'to', node.line), 'to'),
    label: text(required(entries, 'label', node.line), 'label'),
    mark: optional(entries, 'mark') ? text(optional(entries, 'mark') as YamlEntry, 'mark') : null,
    footer: optional(entries, 'footer') ? text(optional(entries, 'footer') as YamlEntry, 'footer') : null,
    action,
    lobbyEvidence: evidence ? text(evidence, 'lobby_evidence') : null,
    extract: extractOf(required(entries, 'extract', node.line).value),
  };
}

function extractOf(node: YamlNode): Extract {
  const entries = mapping(node, 'extract');
  only(entries, ['after', 'before', 'until_blank', 'join', 'box', 'refuse_line']);
  const before = optional(entries, 'before');
  const until = flag(optional(entries, 'until_blank'), 'until_blank');
  if (!before && !until) fail(node.line, 'extract needs before or until_blank');
  return {
    after: text(required(entries, 'after', node.line), 'after'),
    before: before ? text(before, 'before') : null,
    untilBlank: until,
    join: flag(optional(entries, 'join'), 'join'),
    box: flag(optional(entries, 'box'), 'box'),
    refuseLine: optional(entries, 'refuse_line') ? text(optional(entries, 'refuse_line') as YamlEntry, 'refuse_line') : null,
  };
}

function plain(line: string, box: boolean): string {
  const text = line.replace(/\s+$/g, '');
  if (!box) return text.trim();
  return text.replace(/[│╭╮╰╯┌┐└┘─]/g, '').trim();
}

/** The one folder the dialog shows, or null when it does not show exactly one. */
export function extractFolder(extract: Extract, screen: string): string | null {
  const lines = stripSgr(screen).split('\n');
  if (extract.refuseLine && lines.some((line) => line.includes(extract.refuseLine as string))) return null;
  const start = lines.findIndex((line) => plain(line, extract.box).includes(extract.after));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  let taken: string[];
  if (extract.before) {
    const end = rest.findIndex((line) => plain(line, extract.box).includes(extract.before as string));
    if (end < 0) return null;
    taken = rest.slice(0, end);
  } else {
    const end = rest.findIndex((line) => plain(line, extract.box) === '');
    taken = end < 0 ? rest : rest.slice(0, end);
  }
  const paths = taken.map((line) => plain(line, extract.box)).filter((line) => line !== '');
  if (extract.join) {
    const joined = paths.join('');
    return joined === '' ? null : joined;
  }
  return paths.length === 1 ? (paths[0] as string) : null;
}

/** The recorded label is on screen, marked when the record says so, with its footer. */
export function labelMatches(record: TrustRecord, screen: string): boolean {
  const lines = stripSgr(screen).split('\n');
  const hit = lines.some((line) => {
    const at = line.indexOf(record.label);
    if (at < 0) return false;
    return record.mark === null || line.slice(0, at).includes(record.mark);
  });
  if (!hit) return false;
  const footer = record.footer;
  return footer === null || lines.some((line) => line.includes(footer));
}

type Manifest = { screens?: { file?: string; cli?: string; provenance?: string }[] };

let captures: Set<string> | null = null;

function captureNames(): Set<string> {
  if (captures) return captures;
  const path = fileURLToPath(new URL('../../test/fixtures/conformance.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  captures = new Set();
  for (const screen of manifest.screens ?? []) {
    if (screen.provenance !== 'capture' || !screen.cli || !screen.file) continue;
    captures.add(`${screen.cli}/${basename(screen.file)}`);
  }
  return captures;
}

/** True when the record names a fixture registered as a capture. Absent evidence is not eligible. */
export function isEligible(cli: string, record: TrustRecord): boolean {
  if (record.lobbyEvidence === null) return false;
  return captureNames().has(`${cli}/${record.lobbyEvidence}`);
}
