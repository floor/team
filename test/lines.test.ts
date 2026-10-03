import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStopped, hasSeat, markStopped, restoreSeat, rewriteCount, seatBlocks, seatIsStopped, takeOut } from '../src/file/lines.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writeTeamFile } from '../src/file/write.ts';

const counted = `format: 1
seats:
  - role: implementer
    name: deepseek
    label: deepseek
    count: 2
    stopped: true
    # kept with the entry
    cli: claude-code
  - role: coordinator
    name: lead
    cli: claude-code
`;

describe('the line-level writer', () => {
  test('a count entry becomes explicit seats, and the comment stays', () => {
    const text = rewriteCount(counted, 'deepseek');
    expect(text).not.toBeNull();
    expect(text).toContain('# kept with the entry');
    expect(text).not.toContain('count:');
    expect(text).toContain('name: deepseek\n');
    expect(text).toContain('name: deepseek-2');
    expect(text).toContain('label: deepseek-2');
    expect(text).toContain('name: lead');
    expect(text?.match(/cli: claude-code/g)).toHaveLength(3);
  });

  test('clearing one stopped instance leaves the other stopped', () => {
    const text = clearStopped(counted, 'deepseek-2');
    expect(seatIsStopped(text, 'deepseek')).toBe(true);
    expect(seatIsStopped(text, 'deepseek-2')).toBe(false);
    expect(text).toContain('# kept with the entry');
    expect(text).toContain('name: lead');
  });

  test('a missing seat is put back from the approved copy, beside the neighbour that remains', () => {
    const current = counted.replace(/ {2}- role: implementer[\s\S]*?cli: claude-code\n/, '');
    expect(current).not.toContain('deepseek');
    const restored = restoreSeat(current, counted, 'deepseek-2');
    expect(restored).toContain('name: deepseek-2');
    expect(restored).not.toContain('count:');
    expect(restored).not.toContain('name: deepseek\n');
    expect(restored.indexOf('name: deepseek-2')).toBeLessThan(restored.indexOf('name: lead'));
    expect(restored).toContain('# kept with the entry');
  });

  test('taking one seat out leaves the next seat and a comment that sits above it', () => {
    const text = takeOut(counted, 'deepseek');
    expect(text).not.toContain('name: deepseek\n');
    expect(text).toContain('name: deepseek-2');
    expect(text).not.toContain('count:');
    expect(text).toContain('name: lead');
    const one = takeOut(rewriteCount(counted, 'deepseek') ?? '', 'deepseek-2');
    expect(one).toContain('name: deepseek\n');
    expect(one).not.toContain('name: deepseek-2');
    expect(one).toContain('# kept with the entry');
    expect(one).toContain('name: lead');
  });

  test('stopping one instance of a count leaves the other running', () => {
    const text = markStopped(counted.replace('    stopped: true\n', ''), 'deepseek-2');
    expect(text).not.toContain('count:');
    expect(seatIsStopped(text, 'deepseek')).toBe(false);
    expect(seatIsStopped(text, 'deepseek-2')).toBe(true);
    expect(text).toContain('name: lead');
  });

  test('a name-first seat is found', () => {
    const text = `format: 1
seats:
  - name: helper
    role: implementer
    cli: claude-code
    stopped: true
  - role: coordinator
    name: lead
    cli: claude-code
`;
    expect(hasSeat(text, 'helper')).toBe(true);
    const cleared = clearStopped(text, 'helper');
    expect(seatIsStopped(cleared, 'helper')).toBe(false);
    expect(hasSeat(cleared, 'lead')).toBe(true);
    const gone = without(text, 'helper');
    expect(hasSeat(gone, 'helper')).toBe(false);
    const restored = restoreSeat(gone, text, 'helper');
    expect(hasSeat(restored, 'helper')).toBe(true);
    expect(restored).toContain('- name: helper');
  });

  test('restoring one removed instance of a count entry inserts that instance only', () => {
    const approved = `format: 1
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
    launch: claude
  - role: implementer
    name: ds
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    count: 3
`;
    const split = rewriteCount(approved, 'ds');
    expect(split).not.toBeNull();
    const removed = without(split ?? '', 'ds-2');
    const restored = restoreSeat(removed, approved, 'ds-2');
    const names = seatBlocks(restored).map((block) => block.name);
    expect(names.filter((name) => name === 'ds')).toHaveLength(1);
    expect(names.filter((name) => name === 'ds-2')).toHaveLength(1);
    expect(names.filter((name) => name === 'ds-3')).toHaveLength(1);
    expect(restored).not.toContain('count:');
    expect(validateTeamFile(restored).ok).toBe(true);
  });
});

function without(text: string, name: string): string {
  const block = seatBlocks(text).find((item) => item.name === name);
  if (!block) throw new Error(name);
  const lines = text.split('\n');
  lines.splice(block.start, block.end - block.start);
  return lines.join('\n');
}

describe('the team file write', () => {
  test('an edit that would not validate is refused and the file is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-write-'));
    const path = join(dir, 'team.yaml');
    const original = `format: 1
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
    launch: claude
`;
    writeFileSync(path, original);
    const wrote = writeTeamFile(path, original.replace('format: 1', 'format: 9'));
    expect(wrote.ok).toBe(false);
    if (!wrote.ok) expect(wrote.errors[0]?.message).toContain('format');
    expect(readFileSync(path, 'utf8')).toBe(original);
    rmSync(dir, { recursive: true, force: true });
  });
});
