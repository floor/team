import { describe, expect, test } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../../examples/checks/codex-quota');
const LINE =
  /^(session|daily|weekly) (100|[0-9]{1,2})% (used|left)( resets ([0-9]+h([0-9]+m)?|[0-9]+m))?( at [0-9]{10})?$/;
const EVENT_AT = '2026-10-04T12:00:00.000Z';
const EVENT_UNIX = String(Math.floor(Date.parse(EVENT_AT) / 1000));
const SECRET = 'synthetic-prompt-should-not-print';

function future(hours: number, minutes: number): number {
  return Math.floor(Date.now() / 1000) + hours * 3600 + minutes * 60 + 30;
}

function event(
  primary: Record<string, unknown> | null,
  over: { timestamp?: string | null; secondary?: Record<string, unknown> | null } = {},
): string {
  const row: Record<string, unknown> = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary,
        secondary:
          over.secondary === undefined
            ? { used_percent: 12, window_minutes: 300, resets_at: future(2, 0) }
            : over.secondary,
      },
    },
  };
  if (over.timestamp !== null) row.timestamp = over.timestamp ?? EVENT_AT;
  return JSON.stringify(row);
}

function decoy(): string {
  return JSON.stringify({
    timestamp: '2026-10-04T11:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: SECRET, path: '/tmp/not-a-real-rollout' },
  });
}

function run(env: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync('bun', [script], { encoding: 'utf8', env });
}

/** Writes under a temp CODEX_HOME and runs the script with only PATH, HOME, and CODEX_HOME. */
function inCodexHome(write: (sessions: string, root: string) => void): SpawnSyncReturns<string> {
  const root = mkdtempSync(join(tmpdir(), 'codex-quota-'));
  try {
    const sessions = join(root, 'sessions', '2026', '10', '04');
    mkdirSync(sessions, { recursive: true });
    write(sessions, root);
    return run({ PATH: process.env.PATH ?? '', HOME: root, CODEX_HOME: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeRollout(dir: string, name: string, body: string, mtime: Date): void {
  const path = join(dir, name);
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`);
  utimesSync(path, mtime, mtime);
}

function expectLine(result: SpawnSyncReturns<string>, line: string): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(`${line}\n`);
  expect(line).toMatch(LINE);
  expect(result.stdout).not.toContain(SECRET);
  expect(result.stdout).not.toContain('rollout-');
}

function expectEmpty(result: SpawnSyncReturns<string>): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('');
}

describe('codex-quota', () => {
  test('the newest rollout is the one read', () => {
    const result = inCodexHome((sessions, root) => {
      writeRollout(
        sessions,
        'rollout-2026-10-04T08-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',
        `${decoy()}\n${event({ used_percent: 10, window_minutes: 10080, resets_at: future(114, 4) })}`,
        new Date('2026-10-04T08:00:00Z'),
      );
      writeRollout(
        sessions,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        `${decoy()}\n${event({ used_percent: 39.4, window_minutes: 10080, resets_at: future(114, 4) })}`,
        new Date('2026-10-04T12:00:00Z'),
      );
      const archived = join(root, 'archived_sessions', '2026', '10', '04');
      mkdirSync(archived, { recursive: true });
      writeRollout(
        archived,
        'rollout-2026-10-04T13-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl',
        event({ used_percent: 80, window_minutes: 10080, resets_at: future(114, 4) }),
        new Date('2026-10-04T13:00:00Z'),
      );
      writeRollout(sessions, 'notes.jsonl', event({ used_percent: 99, window_minutes: 10080, resets_at: future(1, 0) }), new Date('2026-10-04T14:00:00Z'));
    });
    expectLine(result, `weekly 39% used resets 114h4m at ${EVENT_UNIX}`);
  });

  test('the last token_count with a primary window wins', () => {
    const result = inCodexHome((sessions) => {
      writeRollout(
        sessions,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        [
          event({ used_percent: 10, window_minutes: 10080, resets_at: future(10, 0) }),
          event({ used_percent: 39, window_minutes: 10080, resets_at: future(114, 4) }),
          event(null),
          decoy(),
          '{',
        ].join('\n'),
        new Date('2026-10-04T12:00:00Z'),
      );
    });
    expectLine(result, `weekly 39% used resets 114h4m at ${EVENT_UNIX}`);
  });

  test('300, 1440 and 10080 map to session, daily and weekly', () => {
    const session = inCodexHome((dir) => {
      writeRollout(dir, 'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl', event({ used_percent: 20.5, window_minutes: 300, resets_at: future(3, 0) }, { secondary: null }), new Date());
    });
    expectLine(session, `session 21% used resets 3h at ${EVENT_UNIX}`);

    const daily = inCodexHome((dir) => {
      writeRollout(dir, 'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl', event({ used_percent: 44, window_minutes: 1440, resets_at: future(0, 44) }, { secondary: null }), new Date());
    });
    expectLine(daily, `daily 44% used resets 44m at ${EVENT_UNIX}`);

    const week = inCodexHome((dir) => {
      writeRollout(dir, 'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl', event({ used_percent: 100, window_minutes: 10080, resets_at: future(1, 1) }, { secondary: null }), new Date());
    });
    expectLine(week, `weekly 100% used resets 1h1m at ${EVENT_UNIX}`);
  });

  test('a past or absent reset is omitted', () => {
    const past = inCodexHome((dir) => {
      writeRollout(
        dir,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        event({ used_percent: 39, window_minutes: 10080, resets_at: 1_600_000_000 }, { secondary: null }),
        new Date(),
      );
    });
    expectLine(past, `weekly 39% used at ${EVENT_UNIX}`);

    const absent = inCodexHome((dir) => {
      writeRollout(
        dir,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        event({ used_percent: 39, window_minutes: 10080 }, { secondary: null }),
        new Date(),
      );
    });
    expectLine(absent, `weekly 39% used at ${EVENT_UNIX}`);
  });

  test('malformed JSON and missing fields print nothing', () => {
    const malformed = inCodexHome((dir) => {
      writeRollout(dir, 'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl', '{not json\n', new Date());
    });
    expectEmpty(malformed);

    const missing = inCodexHome((dir) => {
      writeRollout(
        dir,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        [
          event({ used_percent: 39, window_minutes: 10080, resets_at: future(114, 4) }),
          event({ window_minutes: 10080, resets_at: future(114, 4) }),
        ].join('\n'),
        new Date(),
      );
    });
    expectEmpty(missing);

    const over = inCodexHome((dir) => {
      writeRollout(
        dir,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        event({ used_percent: 100.2, window_minutes: 10080, resets_at: future(1, 0) }),
        new Date(),
      );
    });
    expectEmpty(over);

    const otherWindow = inCodexHome((dir) => {
      writeRollout(
        dir,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        event({ used_percent: 39, window_minutes: 60, resets_at: future(1, 0) }),
        new Date(),
      );
    });
    expectEmpty(otherWindow);

    const noStamp = inCodexHome((dir) => {
      writeRollout(
        dir,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        event({ used_percent: 39, window_minutes: 10080, resets_at: future(1, 0) }, { timestamp: null, secondary: null }),
        new Date(),
      );
    });
    expectEmpty(noStamp);
  });

  test('no rollout prints nothing', () => {
    expectEmpty(inCodexHome(() => {}));
  });

  test('an environment with only PATH and HOME still reads ~/.codex', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-quota-home-'));
    try {
      const sessions = join(home, '.codex', 'sessions', '2026', '10', '04');
      mkdirSync(sessions, { recursive: true });
      writeRollout(
        sessions,
        'rollout-2026-10-04T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
        `${decoy()}\n${event({ used_percent: 39, window_minutes: 10080, resets_at: future(114, 4) })}`,
        new Date(),
      );
      const result = run({ PATH: process.env.PATH ?? '', HOME: home });
      expectLine(result, `weekly 39% used resets 114h4m at ${EVENT_UNIX}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
