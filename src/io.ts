import type { Caller, CallerSources } from './caller.ts';

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
  // Set by tests only. A command asks `callerOf(io, session)`, which otherwise reads the
  // processes: these sources stand in for them, asked about the same session, so the placement
  // a test sees is the one the command itself made.
  callerSources?: (session: string | undefined) => CallerSources;
};

// `argv` is what follows the command's name. The result is the exit code.
export type Command = (argv: string[], io: Io) => Promise<number>;
