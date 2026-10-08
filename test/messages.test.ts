import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRoot } from '../src/file/load.ts';
import { messageFile, plantMessage, receiptFile, runMessages, type MessagePayload } from '../src/commands/messages.ts';
import { keyFingerprint, keyOf, MESSAGE_DOMAIN, messageKeyOf, messageKeyPath, signDomain } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const BODY = 'the message body itself';

let base: string;
let root: string;
let home: string;

function payload(over: Partial<MessagePayload> = {}): MessagePayload {
  const found = findRoot(root);
  if (!found) throw new Error('not a checkout');
  return {
    kind: 'message',
    id: 'm1',
    to: 'lead',
    root: found,
    session: 'acme',
    at: '2026-10-04T09:00:00.000Z',
    body: BODY,
    from: 'harness',
    ...over,
  };
}

async function run(argv: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runMessages(argv, io, { home, now: () => new Date('2026-10-04T09:00:00.000Z') });
  return { code, out: io.out, err: io.err };
}

describe('team messages', () => {
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function project(): void {
    base = mkdtempSync(join(tmpdir(), 'team-messages-'));
    root = join(base, 'acme');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execSync('git init -q -b main', { cwd: root });
    writeTeam();
  }

  function writeTeam(): void {
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  }

  test('an empty mailbox prints that nothing is waiting and creates no key', async () => {
    project();
    const result = await run();
    expect(result).toEqual({ code: 0, out: 'team messages: nothing is waiting\n', err: '' });
    expect(existsSync(messageKeyPath(home))).toBe(false);
    expect(existsSync(join(home, '.config', 'team-key', 'key.json'))).toBe(false);
  });

  test('the approval key and the message key are different files', () => {
    project();
    const approval = keyOf(home);
    expect(existsSync(messageKeyPath(home))).toBe(false);
    const message = messageKeyOf(home);
    expect(keyFingerprint(approval)).not.toBe(keyFingerprint(message));
    expect(existsSync(join(home, '.config', 'team-key', 'key.json'))).toBe(true);
    expect(existsSync(messageKeyPath(home))).toBe(true);
  });

  test('a verifying record prints the body and writes the receipt in the same step', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${BODY}\n`);
    expect(result.err).toBe('');
    const receipt = readFileSync(receiptFile(record.root, 'lead', 'm1'), 'utf8');
    expect(receipt).toContain('"kind": "receipt"');
    expect(receipt).toContain('"id": "m1"');
    expect(receipt).toContain('"to": "lead"');
    const again = await run();
    expect(again).toEqual({ code: 0, out: 'team messages: nothing is waiting\n', err: '' });
    expect(readFileSync(receiptFile(record.root, 'lead', 'm1'), 'utf8')).toBe(receipt);
  });

  test('a bad signature prints no body and writes no receipt', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm1', record, signDomain(MESSAGE_DOMAIN, record, keyOf(home)));
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('team messages: lead/m1 does not verify: the signature is not the message key\'s\n');
    expect(existsSync(receiptFile(record.root, 'lead', 'm1'))).toBe(false);
    expect(existsSync(messageFile(record.root, 'lead', 'm1'))).toBe(true);
  });

  test('a copy under a new id does not verify', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'lead', 'm2', record);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('team messages: lead/m2 does not verify: its id is m1, and the filename is the id\n');
    expect(existsSync(receiptFile(record.root, 'lead', 'm2'))).toBe(false);
  });

  test('a copy into another seat\'s directory does not verify', async () => {
    project();
    const record = payload();
    plantMessage(home, record.root, 'worker', 'm1', record);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('team messages: worker/m1 does not verify: it is addressed to lead\n');
    expect(existsSync(receiptFile(record.root, 'worker', 'm1'))).toBe(false);
  });

  test('a record bound to another checkout or another session does not verify', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    plantMessage(home, found, 'lead', 'm1', payload({ root: '/tmp/elsewhere' }));
    const rootRefusal = await run();
    expect(rootRefusal.out).toBe('');
    expect(rootRefusal.err).toBe('team messages: lead/m1 does not verify: it is bound to another checkout\n');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
    rmSync(messageFile(found, 'lead', 'm1'));
    plantMessage(home, found, 'lead', 'm1', payload({ session: 'other' }));
    const sessionRefusal = await run();
    expect(sessionRefusal.out).toBe('');
    expect(sessionRefusal.err).toBe('team messages: lead/m1 does not verify: it is bound to session "other"\n');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
  });

  test('a record that is not a message prints no body', async () => {
    project();
    messageKeyOf(home);
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    mkdirSync(join(found, '.agents', 'messages', 'lead'), { recursive: true });
    writeFileSync(join(found, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('team messages: lead/m1 does not verify: the record is not a message\n');
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
  });

  test('a waiting record and no message key shows nothing and creates no key', async () => {
    project();
    const found = findRoot(root);
    if (!found) throw new Error('not a checkout');
    mkdirSync(join(found, '.agents', 'messages', 'lead'), { recursive: true });
    writeFileSync(join(found, '.agents', 'messages', 'lead', 'm1.json'), '{}\n');
    const result = await run();
    expect(result).toEqual({ code: 1, out: '', err: 'team messages: no message key; nothing was shown\n' });
    expect(existsSync(messageKeyPath(home))).toBe(false);
    expect(existsSync(receiptFile(found, 'lead', 'm1'))).toBe(false);
  });
});
