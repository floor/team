// What a command gets from the process, so tests can run one without a process.
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
};

// `argv` is what follows the command's name. The result is the exit code.
export type Command = (argv: string[], io: Io) => Promise<number>;
