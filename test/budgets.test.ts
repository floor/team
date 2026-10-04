import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { checkDrift, resolveChecks } from '../src/budgets/checks.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const minimal = `format: 1
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

function valid(text: string) {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result;
}

describe('budgets', () => {
  test('defaults when the section is absent', () => {
    const { team, warnings } = valid(minimal);
    expect(warnings).toEqual([]);
    expect(team.budgets).toEqual({ staleAfter: 1800, checkEvery: 600, marks: [50, 75, 90], accounts: {} });
  });

  test('watch.quota_marks is still read, and budgets.marks replaces it', () => {
    const legacy = valid(`${minimal}watch:\n  quota_marks: [40, 80]\n`);
    expect(legacy.warnings.map((warning) => warning.message)).toEqual([
      'watch.quota_marks is now budgets.marks, and is still read',
    ]);
    expect(legacy.team.budgets.marks).toEqual([40, 80]);
    const both = valid(`${minimal}watch:\n  quota_marks: [40, 80]\nbudgets:\n  marks: [50, 90]\n`);
    expect(both.team.budgets.marks).toEqual([50, 90]);
    expect(both.warnings.map((warning) => warning.message)).toContain('budgets.marks replaces watch.quota_marks');
  });

  test('a subscription reserve and a spend floor', () => {
    const { team } = valid(`${minimal}budgets:\n  accounts:\n    openai: { kind: subscription, reserve: 10%, sources: [status_line] }\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }\n`);
    expect(team.budgets.accounts.openai).toEqual({
      kind: 'subscription', shared: false, reserve: 10, floor: null, sources: ['status_line'], check: null,
    });
    expect(team.budgets.accounts.deepseek).toMatchObject({
      kind: 'spend', floor: { amount: 5, currency: 'USD' }, sources: ['check'], check: 'deepseek-balance',
    });
  });

  test('a spend account never reads a screen', () => {
    const result = validateTeamFile(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [status_line] }\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.message.includes('never reads a screen'))).toBe(true);
  });

  test('changing marks needs a new approval', () => {
    const before = valid(`${minimal}budgets:\n  marks: [50, 75, 90]\n`).team;
    const after = valid(`${minimal}budgets:\n  marks: [60]\n`).team;
    const names = fingerprints(after).sections;
    expect(names.budgets).not.toBe(fingerprints(before).sections.budgets);
  });

  test('a changed check file is drift, and the bytes are not the message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-check-'));
    const command = join(dir, 'balance');
    writeFileSync(command, '#!/bin/sh\necho ok\n');
    chmodSync(command, 0o755);
    const team = valid(`${minimal}budgets:\n  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: ${command} }\n`).team;
    const first = resolveChecks(team, dir, '');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(command, '#!/bin/sh\necho other\n');
    const second = resolveChecks(team, dir, '');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(checkDrift(first.checks, second.checks)).toEqual(['the check for deepseek changed']);
    expect(JSON.stringify(checkDrift(first.checks, second.checks))).not.toContain('echo');
  });
});
