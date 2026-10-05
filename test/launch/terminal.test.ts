import { describe, expect, test } from 'bun:test';
import { HELD_SIGNALS, processSignals, terminalReader } from '../../src/launch/terminal.ts';
import type { KeyStream, Signals } from '../../src/launch/terminal.ts';

/** A TTY stream that records what a read did to it, with the data pushed by the test. */
function fakeStream(over: Partial<KeyStream> = {}) {
  const stream = {
    isTTY: true,
    calls: [] as Array<boolean | 'resume' | 'pause'>,
    raw: false,
    listeners: new Map<string, Set<(chunk: string | Buffer) => void>>(),
    setRawMode(mode: boolean) {
      this.calls.push(mode);
      this.raw = mode;
    },
    resume(this: { calls: Array<boolean | 'resume' | 'pause'> }) {
      this.calls.push('resume');
    },
    pause(this: { calls: Array<boolean | 'resume' | 'pause'> }) {
      this.calls.push('pause');
    },
    on(event: 'data' | 'end', listener: (chunk: string | Buffer) => void) {
      (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event))!.add(listener);
      return this;
    },
    removeListener(event: 'data' | 'end', listener: (chunk: string | Buffer) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event: 'data' | 'end', chunk: string | Buffer = '') {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(chunk);
    },
    ...over,
  };
  return stream;
}

function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  const raised: string[] = [];
  const signals: Signals & { fire(signal: string): void; raised: string[]; held(): string[] } = {
    on(signal, handler) {
      (handlers.get(signal) ?? handlers.set(signal, new Set()).get(signal))!.add(handler);
    },
    off(signal, handler) {
      handlers.get(signal)?.delete(handler);
    },
    reRaise(signal) {
      raised.push(signal);
    },
    fire(signal) {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler();
    },
    raised,
    held: () => [...handlers.keys()].filter((signal) => (handlers.get(signal)?.size ?? 0) > 0),
  };
  return signals;
}

describe('one key, from the owner\'s terminal', () => {
  test('a key arrives: raw mode is entered for the read and left before it resolves', async () => {
    const stream = fakeStream();
    const reading = terminalReader(stream).key(5000);
    stream.emit('data', 'o');
    expect(await reading).toBe('o');
    expect(stream.calls).toEqual([true, 'resume', false, 'pause']);
    expect(stream.raw).toBe(false);
  });

  test('the keys: o, s, q, Ctrl-C as q, anything else as other', async () => {
    for (const [chunk, expected] of [['o', 'o'], ['s', 's'], ['q', 'q'], ['\x03', 'q'], ['O', 'other'], ['\r', 'other'], ['x', 'other']] as const) {
      const stream = fakeStream();
      const reading = terminalReader(stream).key(5000);
      stream.emit('data', chunk);
      expect(await reading).toBe(expected);
      expect(stream.raw).toBe(false);
    }
  });

  test('a chunk that carries several bytes takes the first and leaves the rest', async () => {
    const stream = fakeStream();
    const reading = terminalReader(stream).key(5000);
    stream.emit('data', 'qo');
    expect(await reading).toBe('q');
  });

  test('an empty chunk changes nothing; the read stays open', async () => {
    const stream = fakeStream();
    const reading = terminalReader(stream).key(20);
    stream.emit('data', Buffer.from(''));
    expect(await reading).toBe('timeout');
  });

  test('nothing typed: the read times out and the mode is left raw off', async () => {
    const stream = fakeStream();
    expect(await terminalReader(stream).key(10)).toBe('timeout');
    expect(stream.calls).toEqual([true, 'resume', false, 'pause']);
  });

  test('a closed input reads as eof, not as an endless wait', async () => {
    const stream = fakeStream();
    const reading = terminalReader(stream).key(5000);
    stream.emit('end');
    expect(await reading).toBe('eof');
    expect(stream.raw).toBe(false);
  });

  test('no timeout when the wait is not a finite positive number', async () => {
    const stream = fakeStream();
    const reading = terminalReader(stream).key(Number.POSITIVE_INFINITY);
    stream.emit('data', 's');
    expect(await reading).toBe('s');
  });
});

describe('the terminal is never left raw', () => {
  test('a signal while reading restores the mode, drops the handlers and re-raises', async () => {
    const stream = fakeStream();
    const signals = fakeSignals();
    const reading = terminalReader(stream, signals).key(5000);
    expect(signals.held().sort()).toEqual([...HELD_SIGNALS].sort());
    signals.fire('SIGINT');
    expect(stream.raw).toBe(false);
    expect(signals.held()).toEqual([]);
    expect(signals.raised).toEqual(['SIGINT']);
    // The read itself never resolves: the process it belonged to is dying.
    void reading;
  });

  test('a setup error restores the mode and rejects', async () => {
    const stream = fakeStream({
      on() {
        throw new Error('the stream is broken');
      },
    } as Partial<KeyStream>);
    await expect(terminalReader(stream).key(5000)).rejects.toThrow('the stream is broken');
    expect(stream.raw).toBe(false);
    expect(stream.calls).toEqual([true, 'resume', false, 'pause']);
  });

  test('the read after a completed one starts from raw off', async () => {
    const stream = fakeStream();
    const terminal = terminalReader(stream);
    const first = terminal.key(5000);
    stream.emit('data', 'x');
    expect(await first).toBe('other');
    const second = terminal.key(5000);
    stream.emit('data', 'q');
    expect(await second).toBe('q');
    expect(stream.calls).toEqual([true, 'resume', false, 'pause', true, 'resume', false, 'pause']);
  });

  test('every handler the reader installed is gone after a read ends', async () => {
    const stream = fakeStream();
    const signals = fakeSignals();
    const reading = terminalReader(stream, signals).key(5000);
    stream.emit('data', 'o');
    expect(await reading).toBe('o');
    expect(signals.held()).toEqual([]);
  });

  test('the process defaults the reader names are the process\'s own', () => {
    expect(processSignals.reRaise).toBeDefined();
    expect(HELD_SIGNALS).toContain('SIGINT');
  });
});
