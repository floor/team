import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { approvedFingerprints, approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { compare, describe as describeDifference, fingerprints } from '../src/approve/fingerprint.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { storePath, writeApproval, type ApprovalRecord } from '../src/store/store.ts';

const root = '/delegate-approval/root';

const base = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const entry = (pane: string, commands: string) => `  - pane: ${pane}\n    commands: [${commands}]\n`;

function teamOf(text: string) {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.team;
}

/** A record over `text`. `before` takes out the section's fingerprint and leaves the copy without
 *  it, the record a file approved before the section existed left. */
function recordOf(text: string, before: boolean): ApprovalRecord {
  const approval = approvalOf(teamOf(text), root);
  if (before) delete approval.fingerprints.sections.delegates;
  return { approval, file: text };
}

function homeOf(record: ApprovalRecord): string {
  const home = mkdtempSync(join(tmpdir(), 'team-delegate-approval-'));
  writeApproval(storePath('acme', root, home), record, [], home);
  return home;
}

describe('an approval and the delegates section', () => {
  // The test that matters most: the section's arrival alone is not drift. A record written before
  // it reads its stored copy, which has no section, as `delegates: null` — the same value the
  // live file has — and only a real edit to the section differs.
  test('a record written before the section stays in force while the file has none, and differs once it has one', () => {
    const home = homeOf(recordOf(base, true));
    expect(approvalDifferences(teamOf(base), root, home)).toEqual([]);
    expect(approvalDifferences(teamOf(`delegates:\n${entry('main/w1:p1', 'up')}${base}`), root, home)).toEqual([
      '`delegates` changed',
    ]);
  });

  test('an addition, a removal, a pane change, a reorder and a list change each differ', () => {
    const one = `delegates:\n${entry('main/w1:p1', 'up, down')}`;
    const before = homeOf(recordOf(base, true));
    const after = homeOf(recordOf(one + base, false));

    // A record written with the section: unchanged is no difference, and each edit is one.
    expect(approvalDifferences(teamOf(one + base), root, after)).toEqual([]);
    expect(approvalDifferences(teamOf(base), root, after)).toEqual(['`delegates` changed']); // removal
    expect(approvalDifferences(teamOf(`delegates:\n${entry('main/w2:p1', 'up, down')}${base}`), root, after)).toEqual([
      '`delegates` changed',
    ]); // pane change
    expect(approvalDifferences(teamOf(`delegates:\n${entry('main/w1:p1', 'down, up')}${base}`), root, after)).toEqual([
      '`delegates` changed',
    ]); // reorder
    expect(approvalDifferences(teamOf(`delegates:\n${entry('main/w1:p1', 'up')}${base}`), root, after)).toEqual([
      '`delegates` changed',
    ]); // list change
    // And the same addition against the record written before the section existed.
    expect(approvalDifferences(teamOf(one + base), root, before)).toEqual(['`delegates` changed']);
  });

  test('differences come in registry order: owner sections, then seats', () => {
    const home = homeOf(recordOf(base, true));
    const live = `rules:\n  - Run the tests your change touches.\ndelegates:\n${entry('main/w1:p1', 'up')}${base.replace(
      'launch: claude --model claude-opus-5-5',
      'launch: claude --model claude-opus-5-6',
    )}`;
    // The record written before the section: `approvedFingerprints` reads `delegates` from its
    // stored copy, and the differences come back in registry order.
    const differences = compare(approvedFingerprints(recordOf(base, true)), fingerprints(teamOf(live)));
    expect(differences).toEqual([
      { kind: 'section', name: 'rules' },
      { kind: 'section', name: 'delegates' },
      { kind: 'seat-changed', name: 'lead' },
    ]);
    expect(differences.map(describeDifference)).toEqual(['`rules` changed', '`delegates` changed', 'seat lead changed']);
    // The same file against the real record, read through `approvedFingerprints`: `delegates`
    // reads from the stored copy (null) and is only a difference because the live file has one.
    expect(approvalDifferences(teamOf(live), root, home)).toEqual([
      '`rules` changed',
      '`delegates` changed',
      'seat lead changed',
    ]);
  });
});
