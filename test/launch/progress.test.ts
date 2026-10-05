// The progress records: one line per seat, rewritten in place on a terminal and written whole,
// alone, to a redirected stdout. The writer's bytes are the contract here; the three-seat run
// proves the run's stdout is the records and nothing else, whatever the seats do.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import { progressWriter, recordText, recordWhat, type ProgressSink } from '../../src/launch/progress.ts';

function sink(isTTY: boolean): { out: string[]; err: string[]; sink: ProgressSink } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY } };
}

describe('the record, as a line', () => {
  test('ready, left out with its reason, and the waiting record the next slice prints', () => {
    expect(recordText('alpha', { kind: 'ready' })).toBe('alpha: ready');
    expect(recordText('alpha', { kind: 'left out', reason: 'timeout' })).toBe('alpha: left out: timeout');
    expect(recordText('alpha', { kind: 'left out', reason: 'trust' })).toBe('alpha: left out: trust');
    expect(recordText('alpha', { kind: 'waiting for owner', classification: 'login' }))
      .toBe('alpha: waiting for owner (login)');
    expect(recordText('alpha', { kind: 'waiting for owner', classification: 'vendor notice' }))
      .toBe('alpha: waiting for owner (vendor notice)');
  });

  test('the log keeps the record without the seat name', () => {
    expect(recordWhat({ kind: 'ready' })).toBe('ready');
    expect(recordWhat({ kind: 'left out', reason: 'permission' })).toBe('left out: permission');
    expect(recordWhat({ kind: 'waiting for owner', classification: 'unsent' })).toBe('waiting for owner (unsent)');
  });
});

describe('the writer', () => {
  test('a terminal line is rewritten with a carriage return and a clear, and ends in one newline', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress('alpha', 'launching');
    records.progress('alpha', 'waiting for its prompt');
    records.progress('alpha', 'naming');
    records.progress('alpha', 'sending its rules');
    records.final('alpha', { kind: 'ready' }, '');
    expect(out.join('')).toBe(
      '\r\x1b[Kalpha: launching'
        + '\r\x1b[Kalpha: waiting for its prompt'
        + '\r\x1b[Kalpha: naming'
        + '\r\x1b[Kalpha: sending its rules'
        + '\r\x1b[Kalpha: ready\n',
    );
    expect(err).toEqual([]);
  });

  test('a terminal detail follows the record it belongs to', () => {
    const { out, err, sink: s } = sink(true);
    const records = progressWriter(s);
    records.progress('beta', 'waiting for its prompt');
    records.final('beta', { kind: 'left out', reason: 'vendor notice' }, '  its workspace was closed without input and the seat left out\n');
    expect(out.join('')).toBe('\r\x1b[Kbeta: waiting for its prompt\r\x1b[Kbeta: left out: vendor notice\n');
    expect(err.join('')).toBe('  its workspace was closed without input and the seat left out\n');
  });

  test('a redirected stdout gets the final records alone, whatever is provisional', () => {
    const { out, err, sink: s } = sink(false);
    const records = progressWriter(s);
    records.progress('alpha', 'launching');
    records.progress('alpha', 'waiting for its prompt');
    records.progress('alpha', 'naming');
    records.progress('alpha', 'sending its rules');
    records.final('alpha', { kind: 'ready' }, '');
    records.progress('beta', 'launching');
    records.final('beta', { kind: 'left out', reason: 'trust' }, '  its workspace was closed without an answer and the seat left out\n');
    expect(out.join('')).toBe('alpha: ready\nbeta: left out: trust\n');
    expect(out.join('')).not.toContain('\r');
    expect(out.join('')).not.toContain('\x1b');
    expect(err.join('')).toBe('  its workspace was closed without an answer and the seat left out\n');
  });
});

describe('a three-seat launch', () => {
  // Three seats in a row: alpha reaches its prompt, beta stops at the vendor notice, gamma
  // never gets one and times out. The panes are named by the seat's label.
  const DETAILS = '  untested on 0.160.0\n'
    + '  its workspace was closed without input and the seat left out\n'
    + '  timed out after 1 s waiting for its idle prompt; the screen last read unknown; left at launched\n'
    + '  run `team up` again to resume it\n';

  function steps(): Step[] {
    const seat = (name: string, cli: string, seconds: number): Step[] => [
      { kind: 'run', argv: [], do: { do: 'create', seat: name, label: name, cwd: '.' } },
      { kind: 'run', argv: [], do: { do: 'launch', seat: name, label: name, command: cli } },
      {
        kind: 'wait',
        text: `until ${name} shows its idle prompt`,
        do: { do: 'idle', seat: name, label: name, cli, seconds, command: cli, pane: `${name}-pane` },
      },
    ];
    return [
      ...seat('alpha', 'claude', 5),
      {
        kind: 'run',
        argv: [],
        do: { do: 'rename', seat: 'alpha', label: 'alpha', seconds: 5, rules: 'message', pane: 'alpha-pane' },
      },
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'deliver', seat: 'alpha', label: 'alpha', cli: 'claude-code', rules: 'Rules.',
          path: '/x/rules/alpha.md', line: 'Read /x/rules/alpha.md (sha256 000000000000): your standing rules.',
          seconds: 5, pane: 'alpha-pane',
        },
      },
      ...seat('beta', 'codex', 5),
      ...seat('gamma', 'claude', 1),
    ];
  }

  function world(): { host: Host; out: string[]; err: string[]; slept: number[]; logged: { who: string; what: string }[] } {
    const out: string[] = [];
    const err: string[] = [];
    const slept: number[] = [];
    const logged: { who: string; what: string }[] = [];
    let t = 0;
    const records = progressWriter({ stdout: (text) => out.push(text), stderr: (text) => err.push(text), isTTY: false });
    const host: Host = {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: (_session, _cwd, label) => ({ pane: `${label}-pane`, workspace: `${label}-ws` }),
      paneRun: () => true,
      typeLine: () => true,
      deliverRules: async () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => ['alpha-pane'],
      classify: (_session, pane): ScreenKind =>
        pane === 'beta-pane' ? 'vendor notice' : pane === 'alpha-pane' ? 'idle' : 'unknown',
      sleep: async () => { slept.push(t); t += 1000; },
      now: () => t,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { err.push(line); },
      log: (who, what) => { logged.push({ who, what }); },
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record, detail) => records.final(seat, record, detail),
      cliVersion: (cli) => (cli === 'codex' ? '0.160.0' : null),
    };
    return { host, out, err, slept, logged };
  }

  test('a redirected stdout is exactly the three records, in file order', async () => {
    const { host, out, err, slept, logged } = world();
    await executePlan(steps(), 'acme', host);
    expect(out.join('')).toBe('alpha: ready\nbeta: left out: vendor notice\ngamma: left out: timeout\n');
    expect(err.join('')).toBe(DETAILS);
    // The polling happened — gamma slept once waiting for a prompt that never came — and the
    // redirected stream saw nothing of it.
    expect(slept).toEqual([0]);
    expect(out.join('')).not.toContain('\r');
    expect(out.join('')).not.toContain('\x1b');
    // One log line per final record, in order, and none while polling.
    expect(logged).toEqual([
      { who: 'alpha', what: 'ready' },
      { who: 'beta', what: 'left out: vendor notice' },
      { who: 'gamma', what: 'left out: timeout' },
    ]);
  });

  test('a terminal rewrites each seat’s line in place, and the final record ends it', async () => {
    const { host, logged } = world();
    // The same run with a terminal: the writer's own flag is what changes, so the fake host
    // swaps the writer for one drawn as a terminal does.
    const tty: string[] = [];
    const ttyErr: string[] = [];
    const records = progressWriter({ stdout: (text) => tty.push(text), stderr: (text) => ttyErr.push(text), isTTY: true });
    const terminal: Host = {
      ...host,
      progress: (seat, state) => records.progress(seat, state),
      final: (seat, record, detail) => records.final(seat, record, detail),
    };
    await executePlan(steps(), 'acme', terminal);
    expect(tty.join('')).toBe(
      '\r\x1b[K' + 'alpha: launching'
        + '\r\x1b[K' + 'alpha: launching'
        + '\r\x1b[K' + 'alpha: waiting for its prompt'
        + '\r\x1b[K' + 'alpha: naming'
        + '\r\x1b[K' + 'alpha: sending its rules'
        + '\r\x1b[K' + 'alpha: ready\n'
        + '\r\x1b[K' + 'beta: launching'
        + '\r\x1b[K' + 'beta: launching'
        + '\r\x1b[K' + 'beta: waiting for its prompt'
        + '\r\x1b[K' + 'beta: left out: vendor notice\n'
        + '\r\x1b[K' + 'gamma: launching'
        + '\r\x1b[K' + 'gamma: launching'
        + '\r\x1b[K' + 'gamma: waiting for its prompt'
        + '\r\x1b[K' + 'gamma: left out: timeout\n',
    );
    // The details are the terminal's second stream, after each record; the record stream holds
    // nothing but records.
    expect(ttyErr.join('')).toBe(DETAILS);
    expect(tty.every((chunk) => chunk.startsWith('\r\x1b[K'))).toBe(true);
    expect(logged.map((entry) => entry.who)).toEqual(['alpha', 'beta', 'gamma']);
  });
});
