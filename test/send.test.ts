// `team send`: the socket channel against fixtures — a fake seat, a fake sockets folder, and a
// real unix socket (a listener this test owns). No pane is read and no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../src/send/uds.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-05T04:00:00.000Z');

let base = '';
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFile(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
`;
}

function world(): { root: string; dir: string; sockets: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), sockets };
}

type Fake = SendHost & { frames: string[]; socketsTried: string[] };

function fake(sockets: string, patch: Partial<SendHost> = {}): Fake {
  const frames: string[] = [];
  const socketsTried: string[] = [];
  return {
    frames,
    socketsTried,
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (socketPath: string, frame: string): Promise<SendOutcome> => {
      socketsTried.push(socketPath);
      frames.push(frame);
      return { ok: true };
    },
    now: () => NOW,
    home: join(base, 'home'),
    ...patch,
  };
}

/** A real listener at `<sockets>/<pid>.sock`, the shape the probe measured, collecting
 *  everything it receives. */
async function listen(sockets: string, pid: number): Promise<{ path: string; received: string[] }> {
  const path = join(sockets, `${String(pid)}.sock`);
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, received };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await new Promise((resolve) => setTimeout(resolve, 5));
}

function record(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

describe('team send: delivered', () => {
  test('writes one measured frame through the real socket client and exits 0', async () => {
    const { root, dir, sockets } = world();
    const { received } = await listen(sockets, 222);
    const io = owner(root);
    const host = fake(sockets, { deliver: (socketPath, frame) => sendFrame(socketPath, frame) });

    const code = await runSend(['lead', 'hello', 'world'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe('lead: delivered\n');
    await until(() => received.length > 0);
    const frame = received.join('');
    expect(frame.endsWith('\n')).toBe(true);
    expect((frame.match(/\n/g) ?? []).length).toBe(1);
    const parsed = JSON.parse(frame) as { type: string; message: { role: string; content: string }; msg_id: string };
    expect(parsed.type).toBe('user');
    expect(parsed.message).toEqual({ role: 'user', content: 'hello world' });
    expect(parsed.msg_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The log keeps the outcome and the size, never the message's text.
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('send [owner] lead: delivered');
    expect(log).not.toContain('hello world');
  });

  test('--file sends the file body as one frame, newlines escaped', async () => {
    const { root, sockets } = world();
    // A file where the socket is expected, so the fixture's own deliver is the one called.
    const host = fake(sockets);
    writeFileSync(join(sockets, '222.sock'), '');
    writeFileSync(join(root, 'note.txt'), 'line one\nline two\n');
    const io = owner(root);

    const code = await runSend(['lead', '--file', 'note.txt'], io, host);

    expect(code).toBe(0);
    expect(host.frames.length).toBe(1);
    const frame = host.frames[0] as string;
    expect((frame.match(/\n/g) ?? []).length).toBe(1);
    const parsed = JSON.parse(frame) as { message: { content: string } };
    expect(parsed.message.content).toBe('line one\nline two\n');
  });

  test('the orchestrator from its recorded pane may send', async () => {
    const { root, dir, sockets } = world();
    record(dir, 'lead', 'w1:p1');
    writeFileSync(join(sockets, '222.sock'), '');
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['lead', 'a note'], io, fake(sockets));

    expect(code).toBe(0);
    expect(io.out).toBe('lead: delivered\n');
  });

  test('the pane probe takes the first process with a socket, shell included', async () => {
    const { root, sockets } = world();
    // Only the shell's pid has a socket: the foreground pids are tried first, then the shell.
    writeFileSync(join(sockets, '111.sock'), '');
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(host.socketsTried).toEqual([join(sockets, '111.sock')]);
  });
});

describe('team send: refused', () => {
  test('an unknown seat names the file s seats and sends nothing', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['ghost', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('ghost: it is not a declared seat');
    expect(io.err).toContain('lead, helper, native');
    expect(host.frames).toEqual([]);
  });

  test('a worker seat may not send', async () => {
    const { root, dir, sockets } = world();
    record(dir, 'helper', 'w2:p1');
    const host = fake(sockets);
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('only the owner, or the orchestrator from its own seat, can send');
    expect(host.frames).toEqual([]);
  });

  test('a native-CLI seat is refused: that channel is not built yet', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('native runs codex');
    expect(io.err).toContain('cross-session socket channel only');
    expect(host.frames).toEqual([]);
  });

  test('a message over the measured limit is refused, never truncated', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'x'.repeat(FRAME_LIMIT)], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('too large for this channel');
    expect(io.err).toContain(String(FRAME_LIMIT));
    expect(host.frames).toEqual([]);
  });

  test('a lock another command holds refuses the send', async () => {
    const { root, dir, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(seatLockPath(dir, 'acme', 'lead'), `${String(process.pid)} deadbeef\n`);
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain(`another command holds it (pid ${String(process.pid)})`);
    expect(host.frames).toEqual([]);
  });
});

describe('team send: unreachable', () => {
  test('a session that cannot be read is unreachable', async () => {
    const { root, sockets } = world();
    const host = fake(sockets, { agents: () => null });
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: unreachable');
    expect(io.err).toContain('could not be read');
  });

  test('no live agent of that name is unreachable', async () => {
    const { root, sockets } = world();
    const host = fake(sockets, { agents: () => [] });
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('no live agent carries that name in the session');
  });

  test('no socket for the pane s processes is unreachable', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('unreachable');
    expect(io.err).toContain('no cross-session socket was found');
    expect(io.err).toContain(sockets);
  });

  test('a socket path with no listener is unreachable through the real client', async () => {
    const { root, sockets } = world();
    // A closed listener here removes its file (measured: `server.close()` unlinks it, so the
    // sender then reads "no socket found"), so the stale path is a plain file at the measured
    // name — the state a socket left by a session that is gone can hold.
    writeFileSync(join(sockets, '222.sock'), '');
    const host = fake(sockets, { deliver: (socketPath, frame) => sendFrame(socketPath, frame) });
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: unreachable');
    // What a non-socket file at the socket's path answers, measured on two platforms: ENOTSOCK on
    // macOS (this build's own run) and ECONNREFUSED on the ubuntu runner (the pull request run's
    // log, 2026-10-10T20:27:34.8654866Z). The client maps both to one sentence; the test accepts
    // either, so neither platform's kernel is baked in.
    expect(io.err).toMatch(/nothing is listening there \((the path is not a socket|the connection was refused)\)/);
  });
});

describe('team send: usage and configuration', () => {
  test('no seat and no message is a usage error that prints the usage', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend([], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('team send: a seat and a message are required');
    expect(io.err).toContain('Usage: team send <seat> <message>');
  });

  test('a seat with no message is a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('a message or --file is required');
  });

  test('a message and --file together are a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--file', 'note.txt'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('a message and --file cannot both be given');
  });

  test('an empty message is a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', ''], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('the message is empty');
  });

  test('a message file that cannot be read is a configuration error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', '--file', 'missing.txt'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('the message file cannot be read: missing.txt');
  });
});
