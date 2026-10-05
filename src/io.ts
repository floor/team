import type { Caller } from './caller.ts';

// What a command gets from the process, so tests can run one without a process.
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  /** Whether stdout is a terminal: only then does `up` or `add` draw a seat's provisional line.
   *  Absent counts as false — a caller that never reads it may leave it out. */
  stdoutIsTTY?: boolean;
  // Set by tests only. A command asks `callerOf(io)`, which otherwise reads the processes.
  caller?: Caller;
};

// `argv` is what follows the command's name. The result is the exit code.
export type Command = (argv: string[], io: Io) => Promise<number>;
