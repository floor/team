import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runApprove, type ApproveSources } from '../src/commands/approve.ts';
import { delegateGate, type DelegateVerdict } from '../src/delegate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const OWNER: Caller = { kind: 'owner' };
// The caller the delegate pane places: a seat of its own session, never this team's.
const DELEGATE: Caller = { kind: 'seat', name: 'main-agent', pane: 'main/w1:p1', session: 'main' };
const NOW = new Date('2026-10-06T09:00:00Z');

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

const withDelegate = `delegates:
  - pane: main/w1:p1
    commands: [up, down, add, remove, approve]
${minimal}`;

type GateInput = Parameters<typeof delegateGate>[0];

/** A gate that answers `verdict` and records each call, so a test can prove it was asked. */
function gateOf(verdict: DelegateVerdict) {
  const calls: GateInput[] = [];
  return {
    calls,
    gate: (input: GateInput): DelegateVerdict => {
      calls.push(input);
      return verdict;
    },
  };
}

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegate-approve-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

async function approve(
  text: string,
  caller: Caller,
  args: string[] = [],
  gate?: ApproveSources['gate'],
): Promise<{ code: number; out: string; err: string; asked: number }> {
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const io = testIo(root, caller);
  let asked = 0;
  const sources: ApproveSources = {
    ask: async () => {
      asked += 1;
      return '1';
    },
    now: () => NOW,
    home,
    ...(gate ? { gate } : {}),
  };
  const code = await runApprove(args, io, sources);
  return { code, out: io.out, err: io.err, asked };
}

describe('a delegated approve', () => {
  test('with no delegates the ordinary refusal stands, byte for byte, and the gate is never asked', async () => {
    const { calls, gate } = gateOf({ kind: 'passed', pane: 'main/w1:p1' });
    const { code, err, asked } = await approve(minimal, DELEGATE, [], gate);
    expect(code).toBe(1);
    expect(err).toContain('team approve: only the owner approves a team file, from a terminal outside herdr; this call is main-agent\n');
    expect(calls.length).toBe(0);
    expect(asked).toBe(0);
  });

  test('a refusal replaces the ordinary one: its text after `team approve: `, exit 1, nothing written', async () => {
    const { calls, gate } = gateOf({
      kind: 'refused',
      id: 'approve.delegate-section',
      text: 'the approved delegate cannot approve a change to the delegate section; the owner approves this one',
    });
    const { code, err } = await approve(withDelegate, DELEGATE, [], gate);
    expect(code).toBe(1);
    expect(err).toBe(
      'team approve: the approved delegate cannot approve a change to the delegate section; the owner approves this one\n',
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe('approve');
    expect(calls[0]?.root).toBe(root);
    expect(calls[0]?.dir).toBe(join(root, '.agents'));
    expect(approvalStanding(root, home).kind).toBe('none');
  });

  test('a passed verdict writes the record naming the pane, asks no question, and logs the run', async () => {
    const { gate } = gateOf({ kind: 'passed', pane: 'main/w1:p1' });
    const { code, out, asked } = await approve(withDelegate, DELEGATE, [], gate);
    expect(code).toBe(0);
    expect(asked).toBe(0); // no seat-count question: there is no owner terminal to trust
    expect(out).toContain('Approved. The record is in');
    const standing = approvalStanding(root, home);
    expect(standing.kind).toBe('verified');
    if (standing.kind !== 'verified') throw new Error('the delegated approval did not verify');
    expect(standing.record.approval.approved_by).toBe('delegate main/w1:p1');
    expect(standing.record.file).toBe(withDelegate);
    expect(readFileSync(join(root, '.agents/team.log'), 'utf8')).toContain(
      `${NOW.toISOString()} delegate [delegate] main/w1:p1 approve\n`,
    );
  });

  test('the owner path is untouched: the gate is not asked and the question still is', async () => {
    const { calls, gate } = gateOf({ kind: 'refused', id: 'approve.delegate', text: 'never reached' });
    const { code, asked } = await approve(withDelegate, OWNER, [], gate);
    expect(code).toBe(0);
    expect(calls.length).toBe(0);
    expect(asked).toBe(1);
    const standing = approvalStanding(root, home);
    expect(standing.kind).toBe('verified');
    if (standing.kind !== 'verified') throw new Error('the approval did not verify');
    expect(standing.record.approval).not.toHaveProperty('approved_by');
  });

  test('--show returns before the caller gate: a delegate reads it and the gate is never asked', async () => {
    const { calls, gate } = gateOf({ kind: 'passed', pane: 'main/w1:p1' });
    const { code, out } = await approve(withDelegate, DELEGATE, ['--show'], gate);
    expect(code).toBe(0);
    expect(out).toContain('Ceilings this approval fixes:');
    expect(calls.length).toBe(0);
    expect(approvalStanding(root, home).kind).toBe('none');
  });

  test('--file is handed to the gate by name, without its dashes', async () => {
    const other = join(base, 'other');
    mkdirSync(join(other, '.agents'), { recursive: true });
    writeFileSync(join(other, '.agents/team.yaml'), withDelegate);
    const { calls, gate } = gateOf({ kind: 'passed', pane: 'main/w1:p1' });
    const { code } = await approve(withDelegate, DELEGATE, ['--file', join(other, '.agents/team.yaml')], gate);
    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]?.flags).toContain('file');
  });
});
