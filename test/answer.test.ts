import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { runApprove } from '../src/commands/approve.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { listFolder, lobbyPath } from '../src/file/landing.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { extractFolder, isEligible, labelMatches, versionMatches, wholeVersion, type TrustRecord } from '../src/profiles/trust-answer.ts';
import { profileFor } from '../src/profiles/index.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { readState, updateState } from '../src/state.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { testIo } from './helpers.ts';

const cursorTrust = readFileSync(new URL('./fixtures/cursor/2026.10.01/trust.txt', import.meta.url), 'utf8');
const cursorIdle = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');
const agyTrust = readFileSync(new URL('./fixtures/antigravity/1.2.16/trust.txt', import.meta.url), 'utf8');
const codexFolder = readFileSync(new URL('./fixtures/codex/0.157.0/trust-folder.txt', import.meta.url), 'utf8');
const codexWide = readFileSync(new URL('./fixtures/codex/0.157.0/trust-folder-163.txt', import.meta.url), 'utf8');
const codexRepo = readFileSync(new URL('./fixtures/codex/0.157.0/trust.txt', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-05T04:00:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function world() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-answer-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const lobby = lobbyPath(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobby, { recursive: true });
  return { root, home, lobby, dir: join(root, '.agents') };
}

function file(lobby: string, dialogs: 'owner' | 'coordinator' | 'omit', cli = 'cursor'): string {
  const dialog = dialogs === 'omit' ? '' : `dialogs:\n  trust: ${dialogs}\n`;
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
${dialog}trust:
  - ${lobby}
seats:
  - role: coordinator
    name: lead
    cli: ${cli}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${cli}
  - role: worker
    name: helper
    cli: ${cli}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${cli}
`;
}

async function approve(root: string, home: string): Promise<void> {
  const code = await runApprove(FILE, testIo(root, { kind: 'owner' }), { ask: async () => '2', now: () => NOW, home });
  expect(code).toBe(0);
}

function wait(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  updateState(dir, (state) => {
    state.sessions.acme = {
      seats: {
        [name]: {
          stage: 'launched',
          pane: 'w1:p1',
          workspace: 'w1',
          waiting: { state: 'waiting-owner', classification: 'trust', ...extra },
        },
      },
      worktrees: {},
    };
  });
}

type Fake = AnswerHost & { keys: string[]; typed: string[]; entered: number; versions: number; screen: string; named: boolean };

function fake(home: string, root: string, screen: string, cli: 'cursor' | 'antigravity'): Fake {
  let at = NOW.getTime();
  let text = screen;
  let status = 'idle';
  const host = {
    keys: [] as string[],
    typed: [] as string[],
    entered: 0,
    versions: 0,
    named: true,
    get screen() { return text; },
    set screen(value: string) { text = value; },
    version(binary: string) {
      host.versions += 1;
      if (binary === 'cursor-agent') return '2026.10.01-14929f9';
      if (binary === 'agy') return '1.2.16';
      if (binary === 'codex') return '0.157.0';
      return '0.0.0';
    },
    agents() {
      return [{ name: host.named ? 'lead' : '', pane: 'w1:p1', workspace: 'w1' }];
    },
    pane() { return text; },
    sendKey(_session: string, _pane: string, key: string) {
      host.keys.push(key);
      text = cli === 'cursor' ? cursorIdle : agyIdle();
      status = 'idle';
      return true;
    },
    rename() { host.named = true; return true; },
    foreground() { return [cli === 'cursor' ? 'cursor-agent' : 'agy']; },
    foregroundCwd() { return lobbyPath(home); },
    list(dir: string) { return listFolder(dir); },
    status() { return status; },
    type(_session: string, _pane: string, value: string) {
      host.typed.push(value);
      text = cli === 'cursor' ? cursorBox(value) : agyBox(value);
      return true;
    },
    enter() {
      host.entered += 1;
      text = cli === 'cursor' ? cursorIdle : agyIdle();
      status = 'working';
      return true;
    },
    now: () => new Date(at),
    sleep: async (ms: number) => { at += ms; },
    home,
    standing: (project: string) => approvalStanding(project, home),
  };
  void root;
  return host;
}

function cursorBox(text: string): string {
  const lines = text.split('\n');
  const body = [`  → ${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `    ${line}`)].join('\n');
  return cursorIdle.replace('  → Plan, search, build anything', body);
}

function agyIdle(): string {
  return `${'─'.repeat(53)}\n>\n${'─'.repeat(53)}\n                              Gemini 3.8 Flash · high\n`;
}

function agyBox(text: string): string {
  const lines = text.split('\n');
  const body = [`> ${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `  ${line}`)].join('\n');
  return `${'─'.repeat(53)}\n${body}\n${'─'.repeat(53)}\n                              Gemini 3.8 Flash · high\n`;
}

function withPath(screen: string, from: string, path: string): string {
  return screen.replace(from, path);
}

describe('what the captures show', () => {
  test('each extractor yields the one folder, and the repository layout yields none', () => {
    const codex = profileFor('codex');
    const cursor = profileFor('cursor');
    const agy = profileFor('antigravity');
    if (!codex || !cursor || !agy) throw new Error('profiles');
    const codexRecord = codex.answers[0];
    const cursorRecord = cursor.answers[0];
    const agyRecord = agy.answers[0];
    if (!codexRecord || !cursorRecord || !agyRecord) throw new Error('records');
    expect(extractFolder(codexRecord.extract, codexFolder)).toBe('<untrusted-scratch-directory-placeholder-sandbox>/codex');
    expect(extractFolder(codexRecord.extract, codexWide)).toBe('<untrusted-scratch-directory-placeholder-sandbox>/codex');
    expect(extractFolder(codexRecord.extract, codexRepo)).toBeNull();
    expect(extractFolder(cursorRecord.extract, cursorTrust)).toBe('<untrusted-directory>');
    expect(extractFolder(agyRecord.extract, agyTrust)).toBe('<project-worktree>');
    expect(labelMatches(cursorRecord, cursorTrust)).toBe(true);
    expect(labelMatches(agyRecord, agyTrust)).toBe(true);
    expect(agyTrust).toContain('> Yes, I trust this folder');
    expect(agyTrust).toContain('enter Confirm');
  });

  test('a run of rows is joined only when it proves one wrapped path', () => {
    const codex = profileFor('codex');
    const codexRecord = codex?.answers[0];
    if (!codexRecord) throw new Error('record');
    const extract = codexRecord.extract;
    // The reviewer's probe: two unrelated rows between the anchor and the blank that
    // together hold the two halves of a lobby path. They are at no indent and the first
    // fills no wrap column, so they are refused rather than joined.
    expect(extractFolder(extract, 'Folder access\n/var/tmp/team/lob\nby\n\n')).toBeNull();
    // A first row that does not fill the wrap column is not the start of a wrapped path,
    // even when a later row sits at the right indent.
    expect(extractFolder(extract, 'Folder access\n  /codex\n  /other\n\n')).toBeNull();
    // A continuation off the capture's indent is not a continuation either.
    expect(extractFolder(extract, 'Folder access\n  <untrusted-scratch-directory-placeholder-sandbox>\n/codex\n\n')).toBeNull();
    // The capture's own shape — first row exactly 51 columns, then the continuation at
    // indent 2 — is one path.
    expect(extractFolder(extract, codexFolder)).toBe('<untrusted-scratch-directory-placeholder-sandbox>/codex');
  });

  test('a record is enabled by its own capture, and Codex also by lobby evidence', () => {
    const codex = profileFor('codex');
    const cursor = profileFor('cursor');
    const agy = profileFor('antigravity');
    const codexRecord = codex?.answers[0];
    const cursorRecord = cursor?.answers[0];
    const agyRecord = agy?.answers[0];
    if (!codexRecord || !cursorRecord || !agyRecord) throw new Error('records');
    expect(isEligible('codex', codexRecord)).toBe(false);
    expect(isEligible('cursor', cursorRecord)).toBe(true);
    expect(isEligible('antigravity', agyRecord)).toBe(true);
    // A capture is named by the manifest's whole path: a basename never enables a record,
    // and a constructed fixture is not a capture.
    expect(isEligible('cursor', { ...cursorRecord, capture: 'trust.txt' })).toBe(false);
    expect(isEligible('codex', { ...codexRecord, capture: 'codex/0.157.0/lobby-constructed.txt' })).toBe(false);
    // Codex also needs lobby evidence, named the same way. lobby-constructed.txt is not a
    // capture — the README says it is not a screen — and the basename stands for Codex's
    // repository-layout capture, which was not taken in the lobby. Neither enables it, so
    // the shipped record stays ineligible.
    expect(isEligible('codex', { ...codexRecord, lobbyEvidence: 'codex/0.157.0/lobby-constructed.txt' })).toBe(false);
    expect(isEligible('codex', { ...codexRecord, lobbyEvidence: 'trust.txt' })).toBe(false);
    // The mechanism itself: evidence naming a registered capture would enable the record.
    // No such capture exists, so no shipped record reaches this.
    expect(isEligible('codex', { ...codexRecord, lobbyEvidence: 'codex/0.157.0/trust-folder.txt' })).toBe(true);
    // A record for another CLI may not claim lobby evidence it does not have.
    expect(isEligible('cursor', { ...cursorRecord, lobbyEvidence: 'cursor/2026.10.01/trust.txt' })).toBe(false);
    expect(isEligible('antigravity', { ...agyRecord, lobbyEvidence: 'antigravity/1.2.16/trust.txt' })).toBe(false);
    const notRenamed: TrustRecord = { ...cursorRecord, capture: 'cursor/2026.10.01/trust-54.txt' };
    expect(isEligible('cursor', notRenamed)).toBe(true);
  });
});

describe('version matching', () => {
  test('a version is read whole', () => {
    expect(wholeVersion('2026.10.01')).toEqual([2026, 10, 1]);
    expect(wholeVersion(' 1.2 ')).toEqual([1, 2]);
    expect(wholeVersion('2026.10.01-beta.1')).toBeNull();
    expect(wholeVersion('2026.10.01+build.7')).toBeNull();
    expect(wholeVersion('codex-cli 1.3.0')).toBeNull();
    expect(wholeVersion('')).toBeNull();
  });

  test('an exact record matches only the printed text', () => {
    // The exact form cursor-agent --version prints on this machine.
    const record = { from: '2026.10.01-14929f9', to: '2026.10.01-14929f9' };
    expect(versionMatches(record, '2026.10.01-14929f9')).toBe(true);
    expect(versionMatches(record, '2026.10.01')).toBe(false);
    expect(versionMatches(record, '2026.10.01-beta.1')).toBe(false);
    expect(versionMatches(record, '2026.10.01-14929f9 ')).toBe(false);
  });

  test('a closed range matches whole versions and nothing decorated', () => {
    const range = { from: '1.2.0', to: '1.4.9' };
    expect(versionMatches(range, '1.2.0')).toBe(true);
    expect(versionMatches(range, '1.3')).toBe(true);
    expect(versionMatches(range, '1.4.9')).toBe(true);
    expect(versionMatches(range, '1.5')).toBe(false);
    expect(versionMatches(range, '1.1.9')).toBe(false);
    expect(versionMatches(range, '1.3.0-rc.1')).toBe(false);
    expect(versionMatches(range, 'codex-cli 1.3.0')).toBe(false);
    expect(versionMatches({ from: '1.2.0', to: '1.4.9-rc.1' }, '1.3.0')).toBe(false);
  });
});

describe('team answer', () => {
  test('cursor and antigravity each send their one key, then become ready', async () => {
    for (const cli of ['cursor', 'antigravity'] as const) {
      const { root, home, lobby, dir } = world();
      writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator', cli));
      await approve(root, home);
      wait(dir, 'lead');
      const source = cli === 'cursor' ? cursorTrust : agyTrust;
      const token = cli === 'cursor' ? '<untrusted-directory>' : '<project-worktree>';
      const host = fake(home, root, withPath(source, token, lobby), cli);
      const boxed = cli === 'cursor' ? cursorBox : agyBox;
      const sample = 'Rules for this session, from the team file:\n- stay';
      expect(boxHoldsText(cli, sample, boxed(sample))).toBe(true);
      const io = testIo(root, { kind: 'owner' });
      expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(0);
      expect(io.out).toBe('lead: trust answered; ready\n');
      expect(io.err).toBe('');
      expect(host.keys).toEqual([cli === 'cursor' ? 'a' : 'enter']);
      expect(host.typed.length).toBe(1);
      expect(host.entered).toBe(1);
      expect(readState(dir).sessions.acme?.seats.lead?.stage).toBe('ready');
      expect(readState(dir).sessions.acme?.seats.lead?.waiting).toBeUndefined();
      const log = readFileSync(join(dir, 'team.log'), 'utf8');
      expect(log).toContain('answer [owner] lead: trust answered');
    }
  });

  test('a retry on recovery sends no key, and a retry that stays idle does not either', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    updateState(dir, (state) => {
      state.sessions.acme = {
        seats: { lead: { stage: 'launched', pane: 'w1:p1', waiting: { state: 'trust-sent-recovery', classification: 'trust' } } },
        worktrees: {},
      };
    });
    const host = fake(home, root, cursorIdle, 'cursor');
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(0);
    expect(host.keys).toEqual([]);
    expect(io.out).toBe('lead: trust answered; ready\n');

    updateState(dir, (state) => {
      const seat = state.sessions.acme?.seats.lead;
      if (seat) seat.waiting = { state: 'trust-sent-recovery', classification: 'trust' };
    });
    const stuck = fake(home, root, 'not a dialog\n', 'cursor');
    const again = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], again, stuck)).toBe(1);
    expect(stuck.keys).toEqual([]);
    expect(again.err).toBe('lead: trust sent; recovery required\n');
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('trust-sent-recovery');

    const rules = fake(home, root, cursorIdle, 'cursor');
    rules.type = () => false;
    const rulesIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], rulesIo, rules)).toBe(1);
    expect(rules.keys).toEqual([]);
    expect(rulesIo.err).toBe('lead: trust sent; recovery required\n');
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: rule delivery');
  });

  test('the recovery state is on disk before the key, and a failed write sends nothing', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);

    // The ordering the reviewer's crash probe needed: at the moment the host is asked
    // for the key, the state already reads recovery.
    wait(dir, 'lead');
    let atSend: string | undefined;
    const ordered = fake(home, root, trust, 'cursor');
    const sends = ordered.sendKey.bind(ordered);
    ordered.sendKey = (session, pane, key) => {
      atSend = readState(dir).sessions.acme?.seats.lead?.waiting?.state;
      return sends(session, pane, key);
    };
    const orderedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], orderedIo, ordered)).toBe(0);
    expect(atSend).toBe('trust-sent-recovery');

    // The reviewer's injected write fault: the atomic temporary path is an existing
    // directory, so the recovery write throws. No key may be sent, and the seat stays
    // waiting-owner; once the fault is removed the command completes normally.
    wait(dir, 'lead');
    const temporary = join(dir, `team.state.json.${process.pid}.tmp`);
    mkdirSync(temporary);
    const faulted = fake(home, root, trust, 'cursor');
    const faultedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], faultedIo, faulted)).toBe(1);
    expect(faulted.keys).toEqual([]);
    expect(faulted.typed).toEqual([]);
    expect(faultedIo.err).toBe('lead: its recovery state could not be recorded\n');
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('answer [owner] lead: refused trust: state');
    rmdirSync(temporary);

    const again = fake(home, root, trust, 'cursor');
    const againIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], againIo, again)).toBe(0);
    expect(again.keys).toEqual(['a']);
    expect(againIo.out).toBe('lead: trust answered; ready\n');
  });

  test('a send that throws keeps recovery, and the retry sends no key', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);
    const thrown = fake(home, root, trust, 'cursor');
    thrown.sendKey = () => { throw new Error('herdr died'); };
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, thrown)).toBe(1);
    expect(io.err).toBe('lead: the key could not be sent; recovery required\n');
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('trust-sent-recovery');
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('answer [owner] lead: refused trust: action');

    const json = testIo(root, { kind: 'owner' });
    const retry = fake(home, root, 'not a dialog\n', 'cursor');
    expect(await runAnswer([...FILE, '--json', 'lead', 'trust'], json, retry)).toBe(1);
    expect(retry.keys).toEqual([]);
    expect(json.err).toBe('');
    expect(JSON.parse(json.out)).toEqual({
      seat: 'lead',
      dialog: 'trust',
      status: 'recovery',
      state: 'trust-sent-recovery',
      reason: 'its idle prompt did not come',
    });
  });

  test('each failed check sends no key', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    const cases: { name: string; screen: string; version?: string; waiting?: Record<string, unknown>; message: string; versions?: number }[] = [];
    const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);
    const parent = withPath(cursorTrust, '<untrusted-directory>', join(home, '.config', 'team'));
    const child = withPath(cursorTrust, '<untrusted-directory>', join(lobby, 'child'));
    const sibling = withPath(cursorTrust, '<untrusted-directory>', join(home, '.config', 'team', 'other'));
    symlinkSync(lobby, join(home, '.config', 'team', 'link'));
    const linked = withPath(cursorTrust, '<untrusted-directory>', join(home, '.config', 'team', 'link'));
    const two = trust.replace(lobby, `${lobby}\n│    ${lobby}                      │`);
    const none = cursorTrust.replace(/.*<untrusted-directory>.*\n/, '');
    const label = trust.replace('[a] Trust this workspace', '[a] Trust this workspacX');
    cases.push(
      { name: 'label', screen: label, message: 'lead: the pane is not the trust dialog' },
      { name: 'trailing slash', screen: withPath(cursorTrust, '<untrusted-directory>', `${lobby}/`), message: 'lead: the dialog does not show the lobby as written: the owner answers it through team up' },
      { name: 'double slash', screen: withPath(cursorTrust, '<untrusted-directory>', lobby.replace('/team/', '//team/')), message: 'lead: the dialog does not show the lobby as written: the owner answers it through team up' },
      { name: 'dot segment', screen: withPath(cursorTrust, '<untrusted-directory>', lobby.replace('/team/', '/./team/')), message: 'lead: the dialog does not show the lobby as written: the owner answers it through team up' },
      { name: 'two paths', screen: two, message: 'lead: the dialog does not show exactly one folder' },
      { name: 'no path', screen: none, message: 'lead: the dialog does not show exactly one folder' },
      { name: 'parent', screen: parent, message: 'lead: ask the owner to approve this exact folder and answer through team up' },
      { name: 'child', screen: child, message: 'lead: ask the owner to approve this exact folder and answer through team up' },
      { name: 'sibling', screen: sibling, message: 'lead: ask the owner to approve this exact folder and answer through team up' },
      { name: 'symlink', screen: linked, message: 'lead: ask the owner to approve this exact folder and answer through team up' },
      { name: 'version', screen: trust, version: '2026.10.02', message: 'lead: this version has no trust answer' },
      { name: 'prerelease version', screen: trust, version: '2026.10.01-beta.1', message: 'lead: this version has no trust answer' },
      { name: 'suffix dropped version', screen: trust, version: '2026.10.01', message: 'lead: this version has no trust answer' },
    );
    for (const item of cases) {
      wait(dir, 'lead');
      const host = fake(home, root, item.screen, 'cursor');
      if (item.version) host.version = () => { host.versions += 1; return item.version ?? null; };
      const io = testIo(root, { kind: 'owner' });
      expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
      expect(host.keys).toEqual([]);
      expect(host.typed).toEqual([]);
      expect(io.err).toBe(`${item.message}\n`);
      expect(io.out).toBe('');
    }

    wait(dir, 'lead', { manual: true });
    const manual = fake(home, root, trust, 'cursor');
    const manualIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], manualIo, manual)).toBe(1);
    expect(manual.keys).toEqual([]);
    expect(manual.versions).toBe(0);
    expect(manualIo.err).toBe('lead: the owner has the pane open\n');

    let reads = 0;
    wait(dir, 'lead');
    const changed = fake(home, root, trust, 'cursor');
    changed.pane = () => { reads += 1; return reads < 2 ? trust : cursorIdle; };
    const changedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], changedIo, changed)).toBe(1);
    expect(changed.keys).toEqual([]);
    expect(changedIo.err).toBe('lead: the pane is not the trust dialog\n');

    const moved = fake(home, root, trust, 'cursor');
    let pass = 0;
    moved.pane = () => { pass += 1; return pass < 2 ? trust : child; };
    const movedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], movedIo, moved)).toBe(1);
    expect(moved.keys).toEqual([]);
    expect(movedIo.err).toBe('lead: ask the owner to approve this exact folder and answer through team up\n');
  });

  describe('process identity checks before sending key', () => {
    function setupIdentitySeat() {
      const { root, home, lobby, dir } = world();
      writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
      updateState(dir, (state) => {
        state.sessions.acme = {
          seats: {
            lead: {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'waiting-owner', classification: 'trust' },
            },
          },
          worktrees: {},
        };
      });
      const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);
      const host = fake(home, root, trust, 'cursor');
      return { root, home, lobby, dir, trust, host };
    }

    test('same: ordered calls include processInfo on both reads and sends key', async () => {
      const { root, home, dir, host } = setupIdentitySeat();
      await approve(root, home);
      const calls: string[] = [];
      const origAgents = host.agents.bind(host);
      host.agents = (session) => { calls.push('agents'); return origAgents(session); };
      host.processInfo = (_session, pane) => {
        calls.push(`processInfo:${pane}`);
        return { shell: 400, foreground: [400, 401] };
      };
      const origVersion = host.version.bind(host);
      host.version = (bin) => { calls.push(`version:${bin}`); return origVersion(bin); };
      const origPane = host.pane.bind(host);
      host.pane = (session, pane) => { calls.push(`pane:${pane}`); return origPane(session, pane); };
      const origCwd = host.foregroundCwd.bind(host);
      host.foregroundCwd = (session, pane) => { calls.push(`foregroundCwd:${pane}`); return origCwd(session, pane); };
      const origList = host.list.bind(host);
      host.list = (d) => { calls.push('list'); return origList(d); };
      const origSendKey = host.sendKey.bind(host);
      host.sendKey = (session, pane, key) => { calls.push(`sendKey:${key}`); return origSendKey(session, pane, key); };

      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(0);
      expect(io.out).toBe('lead: trust answered; ready\n');
      expect(host.keys).toEqual(['a']);
      expect(calls.slice(0, 12)).toEqual([
        'agents',
        'processInfo:w1:p1',
        'version:cursor-agent',
        'pane:w1:p1',
        'foregroundCwd:w1:p1',
        'list',
        'processInfo:w1:p1',
        'version:cursor-agent',
        'pane:w1:p1',
        'foregroundCwd:w1:p1',
        'list',
        'sendKey:a',
      ]);
      expect(readState(dir).sessions.acme?.seats.lead?.stage).toBe('ready');
      expect(readState(dir).sessions.acme?.seats.lead?.waiting).toBeUndefined();
    });

    test('replaced process refuses and sends no key', async () => {
      const { root, home, dir, host } = setupIdentitySeat();
      await approve(root, home);
      host.processInfo = () => ({ shell: 400, foreground: [500] });
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(io.err).toBe('lead: the process in its pane is not the one team launched\n');
      expect(host.keys).toEqual([]);
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('gone process refuses and sends no key', async () => {
      const { root, home, dir, host } = setupIdentitySeat();
      await approve(root, home);
      host.processInfo = () => ({ shell: 400, foreground: [400] });
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(io.err).toBe('lead: the process in its pane is not the one team launched\n');
      expect(host.keys).toEqual([]);
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('unreadable process refuses and sends no key', async () => {
      const { root, home, dir, host } = setupIdentitySeat();
      await approve(root, home);
      host.processInfo = () => null;
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(io.err).toBe('lead: its pane could not be read\n');
      expect(host.keys).toEqual([]);
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('same on first read then replaced on second read refuses and sends no key', async () => {
      const { root, home, dir, host } = setupIdentitySeat();
      await approve(root, home);
      let reads = 0;
      host.processInfo = () => {
        reads += 1;
        return reads === 1 ? { shell: 400, foreground: [400, 401] } : { shell: 400, foreground: [500] };
      };
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(io.err).toBe('lead: the process in its pane is not the one team launched\n');
      expect(host.keys).toEqual([]);
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('normal path: process changes between key and delivery: no type, state stays recovery', async () => {
      const { root, home, dir, host } = setupIdentitySeat();
      await approve(root, home);
      let reads = 0;
      host.processInfo = () => {
        reads += 1;
        // First 2 reads (in inspect) return same; 3rd read (before rules delivery) returns replaced.
        return reads <= 2 ? { shell: 400, foreground: [400, 401] } : { shell: 400, foreground: [500] };
      };
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(host.keys).toEqual(['a']);
      expect(host.typed).toEqual([]);
      expect(io.err).toBe('lead: the process in its pane is not the one team launched\n');
      expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('trust-sent-recovery');
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });
  });

  describe('process identity checks on recovery path', () => {
    function setupRecoverySeat() {
      const { root, home, lobby, dir } = world();
      writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
      updateState(dir, (state) => {
        state.sessions.acme = {
          seats: {
            lead: {
              stage: 'launched',
              pane: 'w1:p1',
              workspace: 'w1',
              launched: { shell: 400, cli: [401] },
              waiting: { state: 'trust-sent-recovery', classification: 'trust' },
            },
          },
          worktrees: {},
        };
      });
      const host = fake(home, root, cursorIdle, 'cursor');
      return { root, home, lobby, dir, host };
    }

    test('regression: recovery + replaced + idle screen -> no type and exits 1', async () => {
      const { root, home, dir, host } = setupRecoverySeat();
      await approve(root, home);
      host.processInfo = () => ({ shell: 400, foreground: [500] });
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(host.keys).toEqual([]);
      expect(host.typed).toEqual([]);
      expect(io.err).toBe('lead: the process in its pane is not the one team launched\n');
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('recovery + gone -> no type and exits 1', async () => {
      const { root, home, dir, host } = setupRecoverySeat();
      await approve(root, home);
      host.processInfo = () => ({ shell: 400, foreground: [400] });
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(host.keys).toEqual([]);
      expect(host.typed).toEqual([]);
      expect(io.err).toBe('lead: the process in its pane is not the one team launched\n');
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('recovery + unreadable -> no type and exits 1', async () => {
      const { root, home, dir, host } = setupRecoverySeat();
      await approve(root, home);
      host.processInfo = () => null;
      const before = readFileSync(join(dir, 'team.state.json'), 'utf8');
      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(1);
      expect(host.keys).toEqual([]);
      expect(host.typed).toEqual([]);
      expect(io.err).toBe('lead: its pane could not be read\n');
      expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(before);
      expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('refused trust: process');
    });

    test('recovery + same -> delivers rules and ordered calls include processInfo', async () => {
      const { root, home, dir, host } = setupRecoverySeat();
      await approve(root, home);
      const calls: string[] = [];
      const origAgents = host.agents.bind(host);
      host.agents = (session) => { calls.push('agents'); return origAgents(session); };
      const origPane = host.pane.bind(host);
      host.pane = (session, pane) => { calls.push(`pane:${pane}`); return origPane(session, pane); };
      host.processInfo = (_session, pane) => {
        calls.push(`processInfo:${pane}`);
        return { shell: 400, foreground: [400, 401] };
      };
      const origFg = host.foreground.bind(host);
      host.foreground = (session, pane) => { calls.push('foreground'); return origFg(session, pane); };
      const origStatus = host.status.bind(host);
      host.status = (session, pane) => { calls.push('status'); return origStatus(session, pane); };
      const origType = host.type.bind(host);
      host.type = (session, pane, text) => { calls.push('type'); return origType(session, pane, text); };
      const origEnter = host.enter.bind(host);
      host.enter = (session, pane) => { calls.push('enter'); return origEnter(session, pane); };

      const io = testIo(root, { kind: 'owner' });
      const code = await runAnswer([...FILE, 'lead', 'trust'], io, host);
      expect(code).toBe(0);
      expect(io.out).toBe('lead: trust answered; ready\n');
      expect(host.keys).toEqual([]);
      expect(host.typed.length).toBe(1);
      expect(calls.slice(0, 8)).toEqual([
        'agents',
        'pane:w1:p1',
        'agents',
        'processInfo:w1:p1',
        'foreground',
        'status',
        'pane:w1:p1',
        'type',
      ]);
      expect(calls).toContain('enter');
      expect(readState(dir).sessions.acme?.seats.lead?.stage).toBe('ready');
      expect(readState(dir).sessions.acme?.seats.lead?.waiting).toBeUndefined();
    });
  });

  test('a lobby path in another case sends nothing', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    // The reviewer's case probe: on a case-insensitive volume the path lands on the
    // lobby and is a wrong spelling; on a case-sensitive one it is a folder outside
    // the lobby. The reading that sends less refuses either.
    const host = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby.toUpperCase()), 'cursor');
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
    expect(host.keys).toEqual([]);
    expect(host.typed).toEqual([]);
    expect([
      'lead: the dialog does not show the lobby as written: the owner answers it through team up\n',
      'lead: ask the owner to approve this exact folder and answer through team up\n',
    ]).toContain(io.err);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a path the row could have padded, a pane in the padded folder, and its sibling send nothing', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    // The folder the padding could hide: the lobby's name plus one trailing space. The
    // extractor strips the row's padding, so the lobby and this folder read the same on
    // screen — Cursor's boxed row has no visible end — and the pane and parent readings
    // are what tell them apart. Each eligible CLI sends neither its key nor its text.
    const hidden = `${lobby} `;
    mkdirSync(hidden);
    for (const cli of ['cursor', 'antigravity'] as const) {
      writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator', cli));
      await approve(root, home);
      const source = cli === 'cursor' ? cursorTrust : agyTrust;
      const token = cli === 'cursor' ? '<untrusted-directory>' : '<project-worktree>';
      wait(dir, 'lead');
      const host = fake(home, root, withPath(source, token, hidden), cli);
      host.foregroundCwd = () => hidden;
      const io = testIo(root, { kind: 'owner' });
      expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
      expect(host.keys).toEqual([]);
      expect(host.typed).toEqual([]);
      expect(host.entered).toBe(0);
      expect(io.err).toBe("lead: the pane's folder is not the lobby as written\n");
    }
    // The plain case, with the sibling gone and the pane in the lobby, still answers.
    rmdirSync(hidden);
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const plain = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    const done = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], done, plain)).toBe(0);
    expect(plain.keys).toEqual(['a']);
    expect(done.out).toBe('lead: trust answered; ready\n');
  });

  test("a pane folder that is not the lobby, or cannot be read, sends nothing", async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);

    // The pane reports the lobby-plus-space folder — one the owner may have deleted after
    // the CLI started there — while the dialog's row trims to the lobby: the byte equality
    // is what refuses, sibling or none.
    wait(dir, 'lead');
    const padded = fake(home, root, trust, 'cursor');
    padded.foregroundCwd = () => `${lobby} `;
    const paddedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], paddedIo, padded)).toBe(1);
    expect(padded.keys).toEqual([]);
    expect(paddedIo.err).toBe("lead: the pane's folder is not the lobby as written\n");

    // herdr reporting no folder is not a pass either.
    wait(dir, 'lead');
    const silent = fake(home, root, trust, 'cursor');
    silent.foregroundCwd = () => null;
    const silentIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], silentIo, silent)).toBe(1);
    expect(silent.keys).toEqual([]);
    expect(silentIo.err).toBe("lead: the pane's folder cannot be read\n");

    // The check is part of each fresh reading: the lobby on the first, the padded name on
    // the second, sends nothing.
    let reads = 0;
    wait(dir, 'lead');
    const moved = fake(home, root, trust, 'cursor');
    moved.foregroundCwd = () => { reads += 1; return reads < 2 ? lobby : `${lobby} `; };
    const movedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], movedIo, moved)).toBe(1);
    expect(moved.keys).toEqual([]);
    expect(movedIo.err).toBe("lead: the pane's folder is not the lobby as written\n");
  });

  test("a sibling name the lobby's plus whitespace, and an unlistable parent, send nothing", async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);
    // The screen shows the lobby exactly and the pane is in it; the name beside it still
    // refuses — it is the folder the row's trimmed end could have hidden — whatever
    // whitespace follows the lobby's name.
    for (const pad of [' ', '\t', ' ']) {
      const hidden = `${lobby}${pad}`;
      mkdirSync(hidden);
      wait(dir, 'lead');
      const beside = fake(home, root, trust, 'cursor');
      const besideIo = testIo(root, { kind: 'owner' });
      expect(await runAnswer([...FILE, 'lead', 'trust'], besideIo, beside)).toBe(1);
      expect(beside.keys).toEqual([]);
      expect(besideIo.err).toBe("lead: the lobby's parent folder holds a name that differs from the lobby's by whitespace alone\n");
      rmdirSync(hidden);
    }

    // A parent that cannot be listed refuses; it is never read as "no such name".
    wait(dir, 'lead');
    const unreadable = fake(home, root, trust, 'cursor');
    unreadable.list = () => null;
    const unreadableIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], unreadableIo, unreadable)).toBe(1);
    expect(unreadable.keys).toEqual([]);
    expect(unreadableIo.err).toBe("lead: the lobby's parent folder cannot be read\n");
  });

  test('antigravity without the mark or the footer sends nothing', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator', 'antigravity'));
    await approve(root, home);
    const trust = withPath(agyTrust, '<project-worktree>', lobby);
    for (const screen of [trust.replace('> Yes, I trust this folder', '  Yes, I trust this folder'), trust.replace('enter Confirm', 'enter ConfirX')]) {
      wait(dir, 'lead');
      const host = fake(home, root, screen, 'antigravity');
      const io = testIo(root, { kind: 'owner' });
      expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
      expect(host.keys).toEqual([]);
      expect(host.typed).toEqual([]);
    }
  });

  test('codex, a claude seat, an owner policy, and the wrong caller send nothing', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator', 'codex'));
    await approve(root, home);
    wait(dir, 'lead');
    const host = fake(home, root, codexRepo, 'cursor');
    host.version = () => '0.157.0';
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
    expect(host.keys).toEqual([]);
    expect(io.err).toBe('lead: this version has no trust answer\n');

    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator', 'claude-code'));
    await approve(root, home);
    wait(dir, 'lead');
    const claude = fake(home, root, codexRepo, 'cursor');
    const claudeIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], claudeIo, claude)).toBe(1);
    expect(claude.keys).toEqual([]);
    expect(claudeIo.err).toBe('lead: this version has no trust answer\n');

    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'owner'));
    await approve(root, home);
    wait(dir, 'lead');
    const policy = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    const policyIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], policyIo, policy)).toBe(1);
    expect(policy.keys).toEqual([]);
    expect(policy.versions).toBe(0);
    expect(policyIo.err).toBe('lead: use team up and [o]\n');
    const unknown = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'nobody', 'trust'], unknown, policy)).toBe(1);
    expect(unknown.err).toBe('nobody: use team up and [o]\n');

    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const seat = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    const seatIo = testIo(root, { kind: 'seat', name: 'helper', pane: 'w1:p2' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], seatIo, seat)).toBe(1);
    expect(seat.keys).toEqual([]);
    expect(seatIo.err).toBe('lead: only the owner, or the coordinator from its own seat, can answer\n');

    const lost = testIo(root, { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], lost, seat)).toBe(1);
    expect(lost.err).toBe('its parent processes can\'t be read to the top\n');
  });

  test('a refusal log names the caller class the caller check returned', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const host = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');

    // The operator's seat, neither owner nor coordinator: not logged as the owner.
    const seat = testIo(root, { kind: 'seat', name: 'helper', pane: 'w1:p2' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], seat, host)).toBe(1);
    expect(host.keys).toEqual([]);
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('answer [seat] lead: refused trust: caller');

    const lost = testIo(root, { kind: 'unplaced', reason: 'it doesn\'t run on a terminal' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], lost, host)).toBe(1);
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toContain('answer [unplaced] lead: refused trust: caller');

    // The authorized caller keeps its own class, and the owner keeps its.
    const coordinator = testIo(root, { kind: 'seat', name: 'lead', pane: 'w1:p1' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], coordinator, host)).toBe(0);
    const log = readFileSync(join(dir, 'team.log'), 'utf8');
    expect(log).toContain('answer [coordinator] lead: trust answered');
    expect(log).not.toContain('answer [owner] lead: refused trust: caller');
  });

  test('an unapproved file and a lock already held send nothing', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    wait(dir, 'lead');
    const host = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
    expect(host.keys).toEqual([]);
    expect(io.err).toBe('the file was never approved on this machine: run `team approve`\n');

    await approve(root, home);
    const hanging = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    hanging.sendKey = () => {
      hanging.keys.push('a');
      hanging.screen = 'still the dialog\n';
      return true;
    };
    hanging.sleep = async (ms) => {
      if (!held) {
        held = true;
        await gate;
      }
      const clock = hanging.now().getTime();
      // The fake clock lives in the closure. Advancing it here keeps the idle wait finite once released.
      void clock;
      void ms;
    };
    const first = runAnswer([...FILE, 'lead', 'trust'], testIo(root, { kind: 'owner' }), hanging);
    for (let i = 0; i < 50 && !held; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hanging.keys).toEqual(['a']);
    const second = testIo(root, { kind: 'owner' });
    const other = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    expect(await runAnswer([...FILE, 'lead', 'trust'], second, other)).toBe(1);
    expect(other.keys).toEqual([]);
    expect(second.err).toBe('lead: another command holds it\n');
    release();
    expect(await first).toBe(1);
  });

  test('json is one object and stderr stays empty', async () => {
    const { root, home, lobby, dir } = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer(['--json'], io, fake(home, root, '', 'cursor'))).toBe(2);
    expect(io.err).toBe('');
    expect(JSON.parse(io.out)).toEqual({ error: { code: 'usage', message: 'a seat and trust are required' } });

    writeFileSync(join(dir, 'team.yaml'), 'format: 1\n');
    const bad = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, '--json', 'lead', 'trust'], bad, fake(home, root, '', 'cursor'))).toBe(2);
    expect(bad.err).toBe('');
    expect(JSON.parse(bad.out).error.code).toBe('configuration');

    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'owner'));
    await approve(root, home);
    const refused = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, '--json', 'lead', 'trust'], refused, fake(home, root, '', 'cursor'))).toBe(1);
    expect(refused.err).toBe('');
    expect(JSON.parse(refused.out)).toEqual({ seat: 'lead', dialog: 'trust', status: 'refused', reason: 'lead: use team up and [o]' });
  });

  test('a folder outside the trust list, a key that is not sent, and a seat that is not live', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator').replace(`  - ${lobby}`, '  - .'));
    await approve(root, home);
    wait(dir, 'lead');
    const host = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
    expect(host.keys).toEqual([]);
    expect(io.err).toBe('lead: this folder is not an exact trust entry\n');

    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const refused = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    refused.sendKey = () => false;
    const refusedIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], refusedIo, refused)).toBe(1);
    expect(refusedIo.err).toBe('lead: the key could not be sent; recovery required\n');
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('trust-sent-recovery');

    const missing = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'gone', 'trust'], missing, refused)).toBe(1);
    expect(missing.err).toBe('gone: it is not a live seat\n');
  });
  test('the folder check reads the trust entries of the approved copy, not the live file', async () => {
    const { root, home, lobby, dir } = world();
    const live = file(lobby, 'coordinator');
    writeFileSync(join(dir, 'team.yaml'), live);
    await approve(root, home);
    const standing = approvalStanding(root, home);
    if (standing.kind !== 'verified') throw new Error('expected a verified approval');
    const checked = validateTeamFile(live);
    if (!checked.ok) throw new Error('expected a valid fixture');
    // A record whose fingerprints are the live file's — nothing drifts — while the
    // copy it stored carries a different `trust:` list: only the copy says what the
    // owner approved. The folder check must read the entry list from that copy.
    const copy = live.replace(`  - ${lobby}`, '  - .');
    const host = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    host.standing = () => ({
      ...standing,
      record: { ...standing.record, file: copy, approval: { ...standing.record.approval, fingerprints: fingerprints(checked.team) } },
    });
    wait(dir, 'lead');
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], io, host)).toBe(1);
    expect(host.keys).toEqual([]);
    expect(io.err).toBe('lead: this folder is not an exact trust entry\n');

    const broken = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    broken.standing = () => ({ ...standing, record: { ...standing.record, file: 'format: [' } });
    wait(dir, 'lead');
    const brokenIo = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, 'lead', 'trust'], brokenIo, broken)).toBe(1);
    expect(broken.keys).toEqual([]);
    expect(brokenIo.err).toBe('the approved copy of the team file cannot be read\n');
  });

  test('json success and recovery are the stated objects', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const host = fake(home, root, withPath(cursorTrust, '<untrusted-directory>', lobby), 'cursor');
    const io = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, '--json', 'lead', 'trust'], io, host)).toBe(0);
    expect(io.err).toBe('');
    expect(JSON.parse(io.out)).toEqual({ seat: 'lead', dialog: 'trust', status: 'answered', state: 'ready' });

    updateState(dir, (state) => {
      const seat = state.sessions.acme?.seats.lead;
      if (seat) seat.waiting = { state: 'trust-sent-recovery', classification: 'trust' };
    });
    const stuck = fake(home, root, 'not a dialog\n', 'cursor');
    const again = testIo(root, { kind: 'owner' });
    expect(await runAnswer([...FILE, '--json', 'lead', 'trust'], again, stuck)).toBe(1);
    expect(again.err).toBe('');
    expect(stuck.keys).toEqual([]);
    expect(JSON.parse(again.out)).toEqual({
      seat: 'lead',
      dialog: 'trust',
      status: 'recovery',
      state: 'trust-sent-recovery',
      reason: 'its idle prompt did not come',
    });
  });

  test('status and doctor say what is waiting', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, 'coordinator'));
    await approve(root, home);
    wait(dir, 'lead');
    const trust = withPath(cursorTrust, '<untrusted-directory>', lobby);
    const live: Live = {
      running: true,
      agents: [{ name: 'lead', agent: 'cursor', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
      workspaces: [],
      screens: {},
    };
    const sources: StatusSources = {
      live: () => live,
      branch: () => null,
      standing: (project) => approvalStanding(project, home),
      now: () => NOW,
      home,
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runStatus(FILE, io, sources)).toBe(1);
    expect(io.out).toContain('waiting for owner (trust)');
    expect(io.out).toContain('team answer lead trust');
    const json = testIo(root, { kind: 'owner' });
    expect(await runStatus([...FILE, '--json'], json, sources)).toBe(1);
    const row = (JSON.parse(json.out) as { rows: { name: string; state: string }[] }).rows.find((item) => item.name === 'lead');
    expect(row?.state).toBe('waiting-owner');

    const doctorSources: DoctorSources = {
      version: () => '2026.10.01-14929f9',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
      paneText: () => trust,
      standing: (project) => approvalStanding(project, home),
    };
    const doctor = testIo(root, { kind: 'owner' });
    await runDoctor(FILE, doctor, doctorSources);
    expect(doctor.out).toContain('--    lead: waiting for owner at trust\n');
  });
});
