// Tamper-evidence: a signed approval record refuses edits it did not sign, and
// every reader hears the same verdict from one snapshot. The tests that drove
// the design: a changed stored `file` under a valid signature, a replayed older
// record, a record from another project, a legacy unsigned record, a second
// project's approval, and a crash between the generation bump and the write.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalCase, approvalOf, approvedFingerprints, budgetsInForce, budgetsInForceOf, recordSeatDigest, verifiedOf, watchInForce, watchInForceOf } from '../../src/approve/approval.ts';
import { fingerprints } from '../../src/approve/fingerprint.ts';
import { overridesInForceOf } from '../../src/profiles/overrides.ts';
import { runChecksOf } from '../../src/budgets/run.ts';
import { canonicalPayload, installKey, keyFingerprint, keyOf } from '../../src/store/keys.ts';
import { approvalStanding, LEGACY_LINE, payloadOf, type Standing } from '../../src/store/store.ts';
import { approvedCopy, readApproval, storePath, writeApproval } from '../../src/store/store.ts';
import { defaultBudgets, defaultWatch, validateTeamFile } from '../../src/file/validate.ts';
import { loadTeamFile } from '../../src/file/load.ts';

let home: string;
let root: string;

const FILE = `format: 1
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
`;

const BUDGETS_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
budgets:
  accounts:
    anthropic:
      kind: subscription
      reserve: 20%
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'team-evidence-')));
  root = join(home, 'acme');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.agents-team.yaml'), FILE);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function team(text: string = FILE) {
  writeFileSync(join(root, '.agents-team.yaml'), text);
  const loaded = loadTeamFile(root, { file: '.agents-team.yaml' });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded;
}

/** Approves the file as the owner would, signing the record: the one writer. */
function approve(text: string = FILE, at: Date = new Date('2026-10-03T14:02:00Z')): number {
  const loaded = team(text);
  return writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, at), file: text },
    loaded.team.seats,
    home,
    at,
  );
}

function standing(): Standing {
  return approvalStanding(realpathSync(root), home);
}

function stored(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(storePath('acme', realpathSync(root), home), 'approval.json'), 'utf8'));
}

function restore(record: Record<string, unknown>): void {
  writeFileSync(join(storePath('acme', realpathSync(root), home), 'approval.json'), `${JSON.stringify(record, null, 2)}\n`);
}

describe('the canonical encoding', () => {
  test('key order does not change the bytes, and different values never share them', () => {
    const one = canonicalPayload({ format: 2, file: 'a', generation: 1, approval: { b: 1, a: 2 } } as never);
    const two = canonicalPayload({ format: 2, file: 'a', generation: 1, approval: { a: 2, b: 1 } } as never);
    expect(Buffer.compare(one, two)).toBe(0);
    expect(canonicalPayload({ format: 2, file: 'a', generation: 1, approval: { a: '1' } } as never).toString())
      .not.toBe(canonicalPayload({ format: 2, file: 'a', generation: 1, approval: { a: 1 } } as never).toString());
    expect(canonicalPayload({ format: 2, file: 'a', generation: 1, approval: { a: [1, 2] } } as never).toString())
      .not.toBe(canonicalPayload({ format: 2, file: 'a', generation: 1, approval: { a: [2, 1] } } as never).toString());
  });

  test('the bytes are the domain tag, then JSON that round-trips', () => {
    const bytes = canonicalPayload({ format: 2, file: 'a\nb', generation: 3, approval: { a: null, b: true } } as never);
    expect(bytes.subarray(0, 17).toString()).toBe('team-approval-v1\n');
    expect(JSON.parse(bytes.subarray(17).toString())).toEqual({ approval: { a: null, b: true }, file: 'a\nb', format: 2, generation: 3 });
  });

  test('a generation outside the safe range is not encoded', () => {
    expect(() => canonicalPayload({ format: 2, file: '', generation: 2 ** 53, approval: {} } as never)).toThrow();
    expect(() => canonicalPayload({ format: 2, file: '', generation: 1.5, approval: {} } as never)).toThrow();
  });
});

describe('a signed record', () => {
  test('verifies, and the standing carries the generation', () => {
    expect(approve()).toBe(1);
    const state = standing();
    expect(state.kind).toBe('verified');
    if (state.kind !== 'verified') return;
    expect(state.generation).toBe(1);
    expect(state.signedAt).toBe('2026-10-03T14:02:00.000Z');
    expect(approvedCopy(realpathSync(root), home)).toBe(FILE);
  });

  test('the key and the generation live outside the store, in their own folder', () => {
    approve();
    const folder = join(home, '.config', 'team-key');
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, 'key.json')).mode & 0o777).toBe(0o600);
    const generations = join(folder, 'generations');
    const files = readdirSync(generations) as string[];
    expect(files.length).toBe(1);
    expect(statSync(join(generations, files[0] as string)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(generations, files[0] as string), 'utf8'))).toEqual({
      format: 1,
      generation: 1,
      at: '2026-10-03T14:02:00.000Z',
    });
    // Nothing of the key sits in the store the seats' rules talk about.
    expect(existsSync(join(storePath('acme', realpathSync(root), home), 'key.json'))).toBe(false);
  });

  test('a changed stored `file` under a valid signature is refused', () => {
    approve(BUDGETS_FILE);
    const record = stored();
    // The edit the reviews made: the reserve, changed through the unsigned copy.
    restore({ ...record, file: (record.file as string).replace('reserve: 20%', 'reserve: 1%') });
    const state = standing();
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('does not carry a valid signature');
    const loaded = team(BUDGETS_FILE);
    // The tampered marks are not in force: the defaults are.
    expect(budgetsInForce(loaded.team, loaded.root, home).accounts).toEqual({});
    expect(approvedCopy(realpathSync(root), home)).toBe(null);
  });

  test('any field of the approval edited without the key is refused', () => {
    approve();
    const record = stored();
    const approval = record.approval ?? record;
    restore({ ...record, ceilings: { ...((approval as Record<string, unknown>).ceilings as object), seats: 99 } });
    expect(standing().kind).toBe('refused');
  });

  test('a replayed older record is refused', () => {
    approve();
    const first = stored();
    approve(FILE, new Date('2026-10-04T09:00:00Z'));
    expect(standing().kind).toBe('verified');
    restore(first);
    const state = standing();
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('#1');
    expect(state.why).toContain('#2');
  });

  test('a record from another project root is refused there and still verifies here', () => {
    approve();
    const other = join(home, 'other');
    mkdirSync(other, { recursive: true });
    const theirs = storePath('other', realpathSync(other), home);
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'approval.json'), readFileSync(join(storePath('acme', realpathSync(root), home), 'approval.json')));
    const state = approvalStanding(realpathSync(other), home);
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('another project root');
    expect(standing().kind).toBe('verified');
  });

  test('a missing key with the record intact fails closed', () => {
    approve();
    rmSync(join(home, '.config', 'team-key'), { recursive: true, force: true });
    const state = standing();
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('key is missing');
  });

  test('a crash between the bump and the write fails closed, saying what to do', () => {
    approve();
    // The interrupted next approval: the generation moved, the record did not.
    const generations = join(home, '.config', 'team-key', 'generations');
    const file = readdirSync(generations)[0] as string;
    const path = join(generations, file);
    const current = JSON.parse(readFileSync(path, 'utf8')) as { generation: number; at: string };
    writeFileSync(path, `${JSON.stringify({ ...current, generation: 2 }, null, 2)}\n`);
    const state = standing();
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('interrupted');
    expect(state.why).toContain('run `team approve` once');
  });

  test('a rolled-back generation fails closed', () => {
    approve();
    approve(FILE, new Date('2026-10-04T09:00:00Z'));
    const generations = join(home, '.config', 'team-key', 'generations');
    const file = readdirSync(generations)[0] as string;
    const path = join(generations, file);
    writeFileSync(path, `${JSON.stringify({ format: 1, generation: 1, at: '2026-10-03T14:02:00.000Z' }, null, 2)}\n`);
    const state = standing();
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('rolled back');
  });

  test('a counter at the top of the safe range refuses the next approval', () => {
    approve();
    const generations = join(home, '.config', 'team-key', 'generations');
    const file = readdirSync(generations)[0] as string;
    const path = join(generations, file);
    writeFileSync(path, `${JSON.stringify({ format: 1, generation: 2 ** 53 - 1, at: '2026-10-03T14:02:00.000Z' }, null, 2)}\n`);
    expect(() => approve(FILE, new Date('2026-10-04T09:00:00Z'))).toThrow(/generation/);
  });

  test('a second project neither disturbs the first nor shares its counter', () => {
    approve();
    const second = join(home, 'bolt');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, '.agents-team.yaml'), FILE.replace('project: acme', 'project: bolt'));
    const loadedSecond = loadTeamFile(second, { file: '.agents-team.yaml' });
    if (!loadedSecond.ok) throw new Error(JSON.stringify(loadedSecond.errors));
    writeApproval(
      storePath(loadedSecond.team.project, loadedSecond.root, home),
      { approval: approvalOf(loadedSecond.team, loadedSecond.root), file: FILE.replace('project: acme', 'project: bolt') },
      loadedSecond.team.seats,
      home,
    );
    // The first project's record still verifies, at its own generation.
    expect(standing().kind).toBe('verified');
    const secondState = approvalStanding(realpathSync(second), home);
    expect(secondState.kind).toBe('verified');
    if (secondState.kind !== 'verified') return;
    expect(secondState.generation).toBe(1);
    // Approving the second project again leaves the first untouched.
    writeApproval(
      storePath(loadedSecond.team.project, loadedSecond.root, home),
      { approval: approvalOf(loadedSecond.team, loadedSecond.root, new Date('2026-10-04T09:00:00Z')), file: FILE.replace('project: acme', 'project: bolt') },
      loadedSecond.team.seats,
      home,
      new Date('2026-10-04T09:00:00Z'),
    );
    expect(standing().kind).toBe('verified');
  });

  test('an amendment by add or remove --keep re-signs and moves the generation', () => {
    const two = `${FILE}  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
    approve(two);
    const loaded = team(two);
    const stopped = `${two}    stopped: true\n`;
    const edited = validateTeamFile(stopped);
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    recordSeatDigest(edited.team, loaded.root, 'worker', home);
    const state = standing();
    expect(state.kind).toBe('verified');
    if (state.kind !== 'verified') return;
    expect(state.generation).toBe(2);
    expect(approvedFingerprints(state.record).seats.worker).toBe(fingerprints(edited.team).seats.worker);
  });
});

describe('a legacy record, written before records were signed', () => {
  function legacy(): void {
    const loaded = team();
    const store = storePath(loaded.team.project, loaded.root, home);
    mkdirSync(store, { recursive: true });
    // What an earlier `team` wrote: format 1, no generation, no signature.
    writeFileSync(
      join(store, 'approval.json'),
      `${JSON.stringify({ ...approvalOf(loaded.team, loaded.root), format: 1, file: FILE }, null, 2)}\n`,
    );
  }

  test('is reported with the one-line repair and is not trusted', () => {
    legacy();
    const state = standing();
    expect(state).toEqual({ kind: 'legacy' });
    expect(LEGACY_LINE).toBe('approved before records were signed: run `team approve` once');
    const loaded = team();
    // Reads behave as with no approval at all.
    expect(approvedCopy(realpathSync(root), home)).toBe(null);
    expect(watchInForce(loaded.team, loaded.root, home).interval).toBe(120);
    expect(budgetsInForce(loaded.team, loaded.root, home).accounts).toEqual({});
  });

  test('upgrading by approving once leaves a signed record', () => {
    legacy();
    approve();
    const state = standing();
    expect(state.kind).toBe('verified');
    if (state.kind !== 'verified') return;
    expect(state.generation).toBe(1);
    expect(readApproval(storePath('acme', realpathSync(root), home))?.approval.format).toBe(2);
  });
});

// Round 2: the record's shape is checked before anything is built from it, the
// stored `format` sits inside the signed bytes, the key file is written whole
// or not at all, and the root's identity is its realpath.
describe('round 2: the record\'s shape, the key file, and the root\'s identity', () => {
  test('a malformed format-2 record is refused, whatever is missing or wrong with it', () => {
    approve();
    const flat = stored();
    const broken: unknown[] = [
      // The review's own probe: a record that is format 2 and nothing else.
      { format: 2, file: 'x', generation: 1, signature: '00' },
      { ...flat, approvedAt: null },
      { ...flat, approvedAt: 5 },
      { ...flat, root: null },
      { ...flat, fingerprints: 'none' },
      { ...flat, fingerprints: { seats: {} } },
      { ...flat, fingerprints: { sections: {}, seats: 'none' } },
      { ...flat, ceilings: null },
      { ...flat, ceilings: { seats: 'three', temporary: 0, vendors: {} } },
      { ...flat, ceilings: { seats: 1.5, temporary: 0, vendors: {} } },
      { ...flat, file: null },
      { ...flat, file: ['a'] },
      { ...flat, generation: null },
      { ...flat, generation: 'two' },
      { ...flat, generation: 0 },
      { ...flat, signature: null },
      { ...flat, signature: 9 },
      { ...flat, checks: 'none' },
      { ...flat, overrides: 3 },
    ];
    for (const one of broken) {
      restore(one as Record<string, unknown>);
      // Never a throw, never verified, never legacy: the malformed record is a refusal.
      expect(standing()).toEqual({ kind: 'refused', why: expect.stringContaining('run `team approve` once') });
    }
    // A huge string is read and refused, not crashed on.
    restore({ ...flat, file: 'x'.repeat(1_000_000) });
    expect(standing().kind).toBe('refused');
  });

  test('a record with a field this version does not know is refused, naming the field', () => {
    approve();
    const flat = stored();
    restore({ ...flat, extra: 1 });
    const top = standing();
    expect(top.kind).toBe('refused');
    if (top.kind !== 'refused') return;
    expect(top.why).toContain('"extra"');
    expect(top.why).toContain('does not know');
    restore({ ...flat, ceilings: { ...(flat.ceilings as Record<string, unknown>), bonus: 1 } });
    const nested = standing();
    expect(nested.kind).toBe('refused');
    if (nested.kind !== 'refused') return;
    expect(nested.why).toContain('"ceilings.bonus"');
  });

  test('the stored format field is inside the signed bytes', () => {
    // The payload a signature covers carries the record's own format.
    const loaded = team();
    const approval = approvalOf(loaded.team, loaded.root);
    const payload = payloadOf(approval, FILE, 1) as { approval: { format: number } };
    expect(payload.approval.format).toBe(2);
    expect(canonicalPayload(payload).toString()).toContain('"format":2');

    // A signed record whose stored format is flipped to 1 is refused, never legacy.
    approve();
    restore({ ...stored(), format: 1 });
    const flipped = standing();
    expect(flipped.kind).toBe('refused');
    if (flipped.kind !== 'refused') return;
    expect(flipped.why).toContain('format 1 but carries a signature');

    // A format-1 record with no signature and no generation is still the legacy case.
    const legacyShaped = stored();
    delete legacyShaped.signature;
    delete legacyShaped.generation;
    restore({ ...legacyShaped, format: 1 });
    expect(standing().kind).toBe('legacy');
  });

  test('the key file is written whole, or not at all', () => {
    approve();
    const path = join(home, '.config', 'team-key', 'key.json');
    // A torn or empty key never regenerates silently: that would orphan every record.
    writeFileSync(path, '');
    expect(() => keyOf(home)).toThrow(/restore it from a copy/);
    expect(readFileSync(path, 'utf8')).toBe('');
    const state = standing();
    expect(state.kind).toBe('refused');
    if (state.kind !== 'refused') return;
    expect(state.why).toContain('signing key');
    expect(state.why).toContain('restore');
  });

  test('two first approvals racing end with one key: the first writer wins', () => {
    const folder = join(home, '.config', 'team-key');
    const key = keyOf(home);
    const bytes = readFileSync(join(folder, 'key.json'), 'utf8');
    // The second run uses the key that is already there, and leaves its bytes alone.
    const again = keyOf(home);
    expect(keyFingerprint(again)).toBe(keyFingerprint(key));
    expect(readFileSync(join(folder, 'key.json'), 'utf8')).toBe(bytes);
    // The install step itself loses the race: a key that appeared meanwhile stays.
    expect(installKey(home, { format: 1, algorithm: 'ed25519', private: 'not the same key' })).toBe('exists');
    expect(readFileSync(join(folder, 'key.json'), 'utf8')).toBe(bytes);
    // The installed file is whole and mode 600, in the folder mode 700.
    expect(statSync(join(folder, 'key.json')).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  test('the key fingerprint is short, stable, and of the public key', () => {
    const key = keyOf(home);
    const seen = keyFingerprint(key);
    expect(seen).toMatch(/^[0-9a-f]{12}$/);
    expect(keyFingerprint(keyOf(home))).toBe(seen);
    const other = join(home, 'other-home');
    mkdirSync(other, { recursive: true });
    expect(keyFingerprint(keyOf(other))).not.toBe(seen);
  });

  test('the root\'s identity is its realpath: a symlink and a trailing slash are the same root', () => {
    approve();
    const link = join(home, 'link-to-acme');
    symlinkSync(realpathSync(root), link);
    expect(approvalStanding(link, home).kind).toBe('verified');
    expect(approvalStanding(`${realpathSync(root)}/`, home).kind).toBe('verified');
    expect(storePath('acme', `${root}/`, home)).toBe(storePath('acme', root, home));
  });

  test('a path that differs only by Unicode normalization is never silently rewritten', () => {
    // What the platform does with the two spellings is the platform's own: macOS folds
    // them into one directory (so one store, one approval); Linux keeps them apart (so
    // the second root has nothing approved). Neither is rewritten by `team`.
    const base = realpathSync(home);
    const nfc = join(base, 'café');
    mkdirSync(nfc, { recursive: true });
    writeFileSync(join(nfc, '.agents-team.yaml'), FILE);
    const loaded = loadTeamFile(nfc, { file: '.agents-team.yaml' });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: FILE },
      loaded.team.seats,
      home,
    );
    const nfd = join(base, 'café');
    const state = approvalStanding(nfd, home);
    if (process.platform === 'darwin') expect(state.kind).toBe('verified');
    else expect(state.kind).toBe('none');
  });
});

// Round 2: one snapshot carries a whole operation. A standing that is not
// verified never widens into permissive values — each value says what it
// becomes, and each is the restrictive side.
describe('round 2: what a standing that is not verified yields', () => {
  const refused: Standing = {
    kind: 'refused',
    why: 'the record does not carry a valid signature: it was changed after approval, or written without the key: run `team approve` once',
  };
  const notVerified: Standing[] = [
    { kind: 'none' },
    { kind: 'legacy' },
    refused,
  ];

  test('the budgets in force are the defaults: no account, no check, never the file\'s own', () => {
    const loaded = team(BUDGETS_FILE);
    for (const standing of notVerified) {
      const budgets = budgetsInForceOf(standing, loaded.team);
      expect(budgets).toEqual(defaultBudgets());
      expect(budgets.accounts).toEqual({});
    }
    // And the one verified standing does carry the approved account.
    const verified = verifiedOf(loaded.team, BUDGETS_FILE, loaded.root);
    expect(Object.keys(budgetsInForceOf(verified, loaded.team).accounts)).toEqual(['anthropic']);
  });

  test('the watch in force is the shipped default, never the file\'s own timings', () => {
    const loaded = team(`${FILE}watch:
  interval: 45s
`);
    for (const standing of notVerified) {
      expect(watchInForceOf(standing, loaded.team)).toEqual(defaultWatch());
      expect(watchInForceOf(standing, loaded.team).interval).not.toBe(45);
    }
  });

  test('the overrides in force are the shipped profiles: nothing added', () => {
    const loaded = team();
    for (const standing of notVerified) {
      expect(overridesInForceOf(standing, loaded.team.project, loaded.root, home).profiles).toEqual([]);
    }
  });

  test('every check reads unapproved and is not run', () => {
    const loaded = team(BUDGETS_FILE);
    let ran = 0;
    for (const standing of notVerified) {
      // The defaults name no account, so no check is even listed, and none runs.
      const outcomes = runChecksOf(standing, loaded.team, 0, () => {
        ran += 1;
        throw new Error('no check runs without a verified record');
      });
      expect(outcomes).toEqual([]);
    }
    expect(ran).toBe(0);
    expect(approvalCase(refused, loaded.team)).toEqual({ differences: null, reason: refused.why });
    expect(approvalCase({ kind: 'none' }, loaded.team)).toEqual({ differences: null, reason: null });
  });

  test('the review\'s reproduction: the approved restrictions hold through the operation\'s own snapshot', () => {
    approve(BUDGETS_FILE);
    const loaded = team(BUDGETS_FILE);
    const gate = approvalStanding(loaded.root, home);
    expect(gate.kind).toBe('verified');
    // The store changes after the gate read, the way a swap between two reads would.
    const record = stored();
    restore({ ...record, file: (record.file as string).replace('reserve: 20%', 'reserve: 1%') });
    // The helper's own fresh read now sees defaults — the old bug, at the seam the review probed.
    expect(budgetsInForce(loaded.team, loaded.root, home).accounts).toEqual({});
    // The command's one snapshot still carries the approved restrictions.
    expect(budgetsInForceOf(gate, loaded.team).accounts).toHaveProperty('anthropic');
    expect(budgetsInForceOf(gate, loaded.team).accounts.anthropic).toMatchObject({ reserve: 20 });
  });
});
