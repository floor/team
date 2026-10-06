import type { CallerSources } from './caller.ts';
import type { TeamFile } from './file/types.ts';
import type { HerdrAgent } from './herdr.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import type { State } from './state.ts';
import type { Standing } from './store/store.ts';
import type { DelegateCommand } from './delegate-types.ts';

/**
 * A delegated run, decided and not yet done. `passed` names the approved pane the caller
 * stood in. `refused` is what the command prints after `team <command>: `, with no newline;
 * the id is the exit id.
 */
export type DelegateVerdict =
  | { kind: 'passed'; pane: string }
  | { kind: 'refused'; id: string; text: string };

/**
 * The reads a test replaces. Each one left out is the real read: the approval standing and
 * its stored copy for `root`, the state in `dir`, the agent list herdr gives for a session.
 * Placement is not here. It is `io`, asked about a session, the same way every other command
 * places its caller.
 */
export type DelegateSources = {
  standing?: (root: string) => Standing;
  /** Null when the approved copy cannot be read. */
  approvedCopy?: (root: string) => string | null;
  /** Null when the state cannot be read. */
  state?: (dir: string) => State | null;
  /** Null when herdr doesn't answer for that session. */
  agents?: (session: string) => HerdrAgent[] | null;
  /**
   * Placement sources for one session, when a test does not put them on `io`. The real
   * path uses `io.callerSources`.
   */
  callerSources?: (session: string | undefined) => CallerSources;
};

export function delegateGate(input: {
  command: DelegateCommand;
  team: TeamFile;
  root: string;
  dir: string;
  flags: readonly string[];
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>;
  sources?: DelegateSources;
}): DelegateVerdict {
  // Fail closed until the checks are in: a command that already calls this must not
  // proceed. The next commit replaces this body; the signature above does not change.
  void input.team;
  void input.root;
  void input.dir;
  void input.flags;
  void input.io;
  void input.sources;
  return {
    kind: 'refused',
    id: `${input.command}.delegate`,
    text: 'only the owner or the approved delegate runs this; this call is unplaced (the delegate gate is not in place yet)',
  };
}

/** The refusal `add` gives a delegate whose add would edit the file or the approval. */
export const ADD_DELEGATE_EDIT: { id: 'add.delegate-edit'; text: string } = {
  id: 'add.delegate-edit',
  text: 'the approved delegate cannot change the file or the approval; the owner adds a missing or stopped seat',
};

/**
 * The audit line, written through `logLine` so it is the same cleaning and the same
 * `<time> command [caller] what` shape as every other line. A delegated run calls this
 * exactly when it passes the gate and proceeds to effects.
 */
export function logDelegated(dir: string, pane: string, command: DelegateCommand, now?: Date): void {
  logLine(dir, 'delegate', 'delegate', `${pane} ${command}`, now);
}
