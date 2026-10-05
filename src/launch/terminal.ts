// Reading one key from the owner's terminal.
//
// Raw mode is entered for one read and left the instant the read ends, so the terminal is never
// in raw mode between reads — during pane polls, focus changes, or any other work the pause does.
// Every exit from a read restores it: the key arriving, the timeout, end of input, a setup error,
// and, while a read is in flight, SIGINT, SIGTERM or SIGHUP. A signal restores the mode first,
// removes these handlers and re-raises the signal, so the process dies by the signal's own
// default action and never leaves the owner's terminal raw. In raw mode the line discipline is
// off, so a Ctrl-C arrives as the byte 0x03 rather than as SIGINT: that byte is read as `q`.

/** One read's result. Anything that is not `o`, `s`, `q` or Ctrl-C is `other`. */
export type Key = 'o' | 's' | 'q' | 'other' | 'timeout' | 'eof';

/** The parts of a TTY stream one read uses; a test hands in a fake that records the calls. */
export type KeyStream = {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause?(): void;
  on(event: 'data' | 'end', listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data' | 'end', listener: (chunk: string | Buffer) => void): unknown;
};

/** The process signals watched while a read holds the terminal raw, behind a seam a test owns. */
export type Signals = {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
  /** What the process would do with the signal were every handler gone. */
  reRaise(signal: NodeJS.Signals): void;
};

export const processSignals: Signals = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.removeListener(signal, handler);
  },
  reRaise: (signal) => {
    process.kill(process.pid, signal);
  },
};

/** The signals watched for the length of a read: the ones a terminal hangs up with. */
export const HELD_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export type Terminal = {
  /** One key, at most `ms` (no timeout when it is not a finite positive number). */
  key(ms: number): Promise<Key>;
};

function keyOf(chunk: string): Key {
  const first = chunk[0];
  if (first === 'o') return 'o';
  if (first === 's') return 's';
  if (first === 'q' || first === '\x03') return 'q';
  return 'other';
}

export function terminalReader(stream: KeyStream, signals: Signals = processSignals): Terminal {
  return {
    key(ms: number): Promise<Key> {
      return new Promise<Key>((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const held: Array<() => void> = [];
        const restore = () => {
          try {
            stream.setRawMode?.(false);
          } catch {
            // The stream is gone; there is no mode left to restore.
          }
        };
        const teardown = () => {
          if (timer) clearTimeout(timer);
          stream.removeListener('data', onData);
          stream.removeListener('end', onEnd);
          for (const off of held) off();
          restore();
          stream.pause?.();
        };
        const cleanup = (result: Key) => {
          if (done) return;
          done = true;
          teardown();
          resolve(result);
        };
        const onData = (chunk: string | Buffer) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (text.length === 0) return;
          cleanup(keyOf(text));
        };
        const onEnd = () => cleanup('eof');

        try {
          stream.setRawMode?.(true);
          stream.resume();
          for (const signal of HELD_SIGNALS) {
            const handler = () => {
              // The terminal first, then the process's own death: never left raw.
              restore();
              for (const off of held) off();
              signals.reRaise(signal);
            };
            signals.on(signal, handler);
            held.push(() => signals.off(signal, handler));
          }
          stream.on('data', onData);
          stream.on('end', onEnd);
        } catch (error) {
          done = true;
          teardown();
          reject(error);
          return;
        }
        if (Number.isFinite(ms) && ms > 0) {
          timer = setTimeout(() => cleanup('timeout'), ms);
        }
      });
    },
  };
}
