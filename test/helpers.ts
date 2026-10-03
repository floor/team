import type { Caller } from '../src/caller.ts';
import type { Io } from '../src/io.ts';

export type TestIo = Io & { out: string; err: string };

export function testIo(cwd: string, caller?: Caller): TestIo {
  const io: TestIo = {
    out: '',
    err: '',
    stdout(text) { io.out += text; },
    stderr(text) { io.err += text; },
    cwd,
    env: {},
    stdinIsTTY: false,
    ...(caller ? { caller } : {}),
  };
  return io;
}
