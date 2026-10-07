import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { approvalDifferences } from '../src/approve/approval.ts';
import { OWNER_SECTIONS } from '../src/approve/fingerprint.ts';
import { SECTIONS } from '../src/file/sections/index.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval, type ApprovalRecord } from '../src/store/store.ts';

// The owner-only sections are generated from the section modules now; this is the list the
// modules replaced, and the order is part of the contract: the approval digest reads the
// sections in it, so a reordered list would change what a difference report says first.
test('the generated owner sections equal the hand-kept list, in order', () => {
  expect(OWNER_SECTIONS).toEqual([
    'trust',
    'dialogs',
    'limits',
    'machine',
    'rules',
    'identity',
    'workspace',
    'orchestrator',
    'operator',
    'session',
    'visibility',
    'tools',
    'budgets',
    'watch',
    'watch.checks',
    // New sections are appended: `delegates` came after every owner section there was, so the
    // digests of the sections before it, and the order a difference report prints them in,
    // are the ones records were written with.
    'delegates',
  ]);
});

// Every `after` names a section there is, and none waits on itself: a typo would silently run a
// section before its input exists, so the list checks itself.
test('each section waits only on sections that exist', () => {
  const names = new Set(SECTIONS.map((section) => section.name));
  for (const section of SECTIONS) {
    for (const after of section.after) {
      expect(names.has(after)).toBe(true);
    }
    expect(section.after).not.toContain(section.name);
  }
});

// An approval record written by main's code today (test/fixtures/approval-main.json, its
// fingerprints taken with main's own reader) still verifies the same file on this branch: the
// modules produce the digests main's monolith does. The record carries its own copy of the
// approved text, so the fixture is the proof.
describe('an approval written by main', () => {
  const root = '/flo632a/root';

  // The fixture is the file as main wrote it to the store: the approval's fields with the
  // approved text inside. `writeApproval` takes them apart, so the test puts them back together.
  function record(): ApprovalRecord {
    const { file, ...approval } = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/approval-main.json'), 'utf8'));
    // The capture is a real record from before records were signed; its fingerprints are the
    // point here, and they are read inside a record this version signs.
    return { approval: { ...approval, format: 2 }, file };
  }

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'team-sections-'));
    const source = record();
    const checked = validateTeamFile(source.file);
    if (!checked.ok) throw new Error('the approval fixture\'s copy does not validate; a behaviour change');
    const store = storePath(checked.team.project, root, dir);
    mkdirSync(store, { recursive: true });
    writeApproval(store, source, [], dir);
    return dir;
  }

  test('still verifies the file it approved', () => {
    const where = home();
    const checked = validateTeamFile(record().file);
    if (!checked.ok) throw new Error('unreachable: home() validated the same text');
    expect(approvalDifferences(checked.team, root, where)).toEqual([]);
  });

  // The record's sections map was written by a reader that called the lead's bucket
  // `coordinator`; this reader compares `orchestrator`. The bucket the record lacks is
  // refilled from the copy the record stores, so rewriting the file to the mark — the
  // conversion a team will run once the key is gone — prints no line and needs no new
  // approval.
  test('a conversion to the mark prints no difference', () => {
    const where = home();
    const converted = record().file
      .replace('coordinator: coordinator-seat\n', '')
      .replace('    name: coordinator-seat\n', '    name: coordinator-seat\n    leads: true\n');
    const checked = validateTeamFile(converted);
    if (!checked.ok) throw new Error('the converted fixture does not validate; a behaviour change');
    expect(checked.team.orchestrator).toBe('coordinator-seat');
    expect(approvalDifferences(checked.team, root, where)).toEqual([]);
  });

  test('a lead move is the `orchestrator` difference', () => {
    const where = home();
    const checked = validateTeamFile(record().file.replace('coordinator: coordinator-seat', 'coordinator: operator-seat'));
    if (!checked.ok) throw new Error('the moved fixture does not validate; a behaviour change');
    expect(approvalDifferences(checked.team, root, where)).toEqual(['`orchestrator` changed']);
  });

  test('and the comparison is live: a watch edit still reads as a difference', () => {
    const where = home();
    const checked = validateTeamFile(record().file.replace('interval: 2m', 'interval: 5m'));
    if (!checked.ok) throw new Error('the edited fixture does not validate');
    expect(approvalDifferences(checked.team, root, where)).toEqual(['`watch` changed']);
  });
});
