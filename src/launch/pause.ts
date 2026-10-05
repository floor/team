import type { HerdrAgent, PaneProcesses } from '../herdr.ts';
import { seatProcessVerdict } from './identity.ts';
import { IDLE_POLL_MS } from './plan.ts';
import type { Classification } from './progress.ts';
import type { SeatState } from '../state.ts';
import type { Key } from './terminal.ts';

// A seat that stopped at a dialog `team` may not answer, with its owner at the terminal.
//
// The pause is the whole of the interaction: it records the seat as waiting for its owner —
// with the process identity read at that moment, in the same write — draws the record, and asks
// with one exact line. `o` focuses the pane and never sends a key or a text into it: from there
// the owner works in her own pane, and this loop polls the screen until it reaches its prompt,
// stops at something else, or runs out the profile's idle timeout — then asks again. `s` closes
// the seat's workspace without input and clears its state. `q` and Ctrl-C stop cleanly: the
// caller (execute) closes what this invocation created and writes the stopped records.
//
// The seat lock is taken before each of resume, open, skip and close, and released before the
// prompt is shown: nothing holds the lock while the owner looks at the terminal or while a pane
// is polled. A pane is never typed into, and the workspace of a seat this run did not create is
// never closed.
//
// Under `dialogs.trust: coordinator` the prompt is also re-read on a tick: `team answer` may be
// racing this run, so every timeout and every return takes the lock, reads the state and the
// pane fresh, and follows what it finds — a seat that became ready, a recovery `answer` left
// behind (which is shown and offers the same keys), or the screen's own reading. No trust key is
// ever sent from here.

/** The waiting record a state carries, as this module writes it. */
export type WaitingRecord = NonNullable<SeatState['waiting']>;

export type PauseInput = {
  seat: string;
  /** The fresh reading that stopped the seat: a dialog, or the idle wait's timeout. */
  classification: Classification;
  pane: string;
  workspace?: string;
  /** The waiting record this run resumed into, when the seat was already recorded waiting. */
  recorded?: WaitingRecord;
};

export type PauseResult =
  | { kind: 'idle' }
  | { kind: 'ready'; detail: string }
  | { kind: 'skipped' }
  | { kind: 'stopped' }
  | { kind: 'left out'; reason: string; detail: string };

/** A screen reading: the pane's kind, or one of the classifications a pause can name. */
export type ScreenReading = 'idle' | 'working' | Classification;

export type PauseHost = {
  /** The seat's exclusive lock: its release, or the pid holding it. */
  lock(): { release(): void } | { held: number };
  /** The seat's state, freshly read. */
  state(): SeatState | undefined;
  /** Writes the waiting record — the seat's launched identity, read now, goes in the same
   *  write — with `change` editing the record that is there (or the entry one). */
  write(change: (prior: WaitingRecord | undefined) => WaitingRecord): void;
  /** Removes the waiting field alone: the seat reached its prompt and continues. */
  clear(): void;
  /** Removes the seat's whole launch state: its workspace has been closed. */
  drop(): void;
  /** A fresh screen read of the pane. */
  screen(): ScreenReading;
  /** The pane's process identity now; null when herdr can't tell. */
  process(): PaneProcesses | null;
  /** The session's agents now; null when herdr can't tell. */
  agents(): HerdrAgent[] | null;
  /** Brings the pane to the owner's attention. Sends no key and no text. */
  focus(): boolean;
  /** Closes the seat's workspace, without input. */
  close(workspace: string): boolean;
  /** The seat's waiting record, drawn provisionally while its prompt is open. */
  record(classification: string): void;
  /** One prompt line, on its own line. */
  prompt(line: string): void;
  /** A line said beside the record: a failed focus, a lock another command holds. */
  say(line: string): void;
  /** The seat entered the pause this run: the caller logs its one transition line. */
  entering(classification: Classification): void;
  key(ms: number): Promise<Key>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The seat's idle timeout, in seconds: how long an opened pane is polled. */
  idleTimeout: number;
  /** Whether the prompt is re-read on a tick and the state and pane refreshed each time
   *  (a trust dialog under the coordinator policy). */
  polled: boolean;
};

/** The one key that moves the seat itself; everything else reprints the prompt. */
function promptLine(seat: string, at: string): string {
  return `${seat} is waiting at ${at}: [o] open pane, [s] skip seat, [q] stop cleanly`;
}

/** What the record and prompt show: the classification, or the recovery `answer` left behind. */
type View = { classification: string; recovery: boolean };

function display(view: View): string {
  return view.recovery ? 'trust sent; recovery required' : view.classification;
}

/** The repair for a waiting record whose pane is gone or no longer holds the seat. */
function goneDetail(seat: string): string {
  return `  its record still names it; \`team remove ${seat} --keep\`, then \`team up\`, clears it\n`;
}

/** Why the seat's waiting pane is not the one it was recorded on, or null when it still is. */
function paneProblem(host: PauseHost, pane: string, state: SeatState | undefined): string | null {
  const agents = host.agents();
  if (!agents) return 'its waiting pane could not be read';
  if (!agents.some((agent) => agent.pane === pane)) return 'its waiting pane is gone';
  const verdict = seatProcessVerdict(state?.launched, host.process());
  if (verdict === 'gone' || verdict === 'replaced') return 'its waiting pane holds another process';
  if (verdict === 'unknown' && state?.launched) return 'its waiting pane could not be read';
  return null;
}

type Outcome =
  | { kind: 'done'; result: PauseResult }
  | { kind: 'view'; view: View }
  /** The lock is another command's: nothing was done, the prompt asks again. */
  | { kind: 'held' };

const leftOut = (reason: string, seat: string): Outcome => ({ kind: 'done', result: { kind: 'left out', reason, detail: goneDetail(seat) } });

export async function runPause(input: PauseInput, host: PauseHost): Promise<PauseResult> {
  // The first write. A seat resumed out of a recovery keeps the record exactly as the answer
  // left it — only the owner's path clears that, and it clears it by finishing the seat.
  let view: View;
  if (input.recorded?.state === 'trust-sent-recovery') {
    view = { classification: input.recorded.classification, recovery: true };
  } else {
    view = { classification: input.classification, recovery: false };
    host.write((prior) => ({
      state: 'waiting-owner',
      classification: input.classification,
      ...(prior?.manual ? { manual: true as const } : {}),
    }));
  }
  host.entering(input.classification);
  host.record(display(view));

  for (;;) {
    host.prompt(promptLine(input.seat, view.classification));
    const key = await host.key(host.polled ? IDLE_POLL_MS : Number.POSITIVE_INFINITY);
    if (key === 'q' || key === 'eof') {
      // Ctrl-C reads as `q` in raw mode; a closed input is the same decision made for the owner.
      return { kind: 'stopped' };
    }
    if (key === 'o') {
      const outcome = await open(input, host);
      if (outcome.kind === 'done') return outcome.result;
      if (outcome.kind === 'view') {
        view = outcome.view;
        host.record(display(view));
      }
      continue;
    }
    if (key === 's') {
      const outcome = await skip(input, host);
      if (outcome.kind === 'done') return outcome.result;
      continue;
    }
    if (key === 'timeout') {
      const outcome = await refresh(input, host, view);
      if (outcome.kind === 'done') return outcome.result;
      if (outcome.kind === 'view') {
        view = outcome.view;
        host.record(display(view));
      }
      continue;
    }
    // Any other input: the exact prompt again, and nothing else.
  }
}

/** `o`: the owner takes the pane. The record says so, the pane is focused, and the screen is
 *  polled to the deadline. No key, no text. */
async function open(input: PauseInput, host: PauseHost): Promise<Outcome> {
  const lock = host.lock();
  if ('held' in lock) {
    host.say(`  ${input.seat}: another command holds it; try [o] again\n`);
    return { kind: 'held' };
  }
  try {
    const state = host.state();
    if (state?.stage === 'ready') return { kind: 'done', result: ready(input.seat) };
    const problem = paneProblem(host, input.pane, state);
    if (problem) return leftOut(problem, input.seat);
    host.write((prior) => ({
      ...(prior ?? { state: 'waiting-owner', classification: input.classification }),
      manual: true,
    }));
  } finally {
    lock.release();
  }
  if (!host.focus()) host.say(`  ${input.seat}: its pane could not be focused; open it yourself\n`);

  const deadline = host.now() + host.idleTimeout * 1000;
  for (;;) {
    if (host.now() >= deadline) return { kind: 'view', view: { classification: 'timeout', recovery: false } };
    await host.sleep(IDLE_POLL_MS);
    const held = host.lock();
    if ('held' in held) continue;
    try {
      const state = host.state();
      if (state?.stage === 'ready') return { kind: 'done', result: ready(input.seat) };
      const problem = paneProblem(host, input.pane, state);
      if (problem) return leftOut(problem, input.seat);
      if (state?.waiting?.state === 'trust-sent-recovery') {
        return { kind: 'view', view: { classification: state.waiting.classification, recovery: true } };
      }
      const kind = host.screen();
      if (kind === 'idle') {
        host.clear();
        return { kind: 'done', result: { kind: 'idle' } };
      }
      if (kind === 'working') continue;
      return { kind: 'view', view: { classification: kind, recovery: false } };
    } finally {
      held.release();
    }
  }
}

/** `s`: the seat is skipped. Its workspace is closed without input, its state cleared. */
async function skip(input: PauseInput, host: PauseHost): Promise<Outcome> {
  const lock = host.lock();
  if ('held' in lock) {
    host.say(`  ${input.seat}: another command holds it; try [s] again\n`);
    return { kind: 'held' };
  }
  try {
    const state = host.state();
    const problem = paneProblem(host, input.pane, state);
    if (problem) return leftOut(problem, input.seat);
    const workspace = input.workspace ?? state?.workspace;
    if (workspace && !host.close(workspace)) {
      return { kind: 'done', result: { kind: 'left out', reason: 'its workspace did not close; left as it is', detail: '' } };
    }
    host.drop();
    return { kind: 'done', result: { kind: 'skipped' } };
  } finally {
    lock.release();
  }
}

/** The tick under the coordinator policy: the state and the pane are read fresh, and whatever
 *  they show decides — ready, recovery, the screen's own reading, or a prompt that asks again. */
async function refresh(input: PauseInput, host: PauseHost, view: View): Promise<Outcome> {
  const lock = host.lock();
  if ('held' in lock) return { kind: 'held' };
  try {
    const state = host.state();
    if (state?.stage === 'ready') return { kind: 'done', result: ready(input.seat) };
    const problem = paneProblem(host, input.pane, state);
    if (problem) return leftOut(problem, input.seat);
    if (state?.waiting?.state === 'trust-sent-recovery') {
      return { kind: 'view', view: { classification: state.waiting.classification, recovery: true } };
    }
    const kind = host.screen();
    if (kind === 'idle') {
      // The owner answered in the pane between ticks: the seat can finish normally.
      host.clear();
      return { kind: 'done', result: { kind: 'idle' } };
    }
    if (kind === 'working') return { kind: 'view', view };
    return { kind: 'view', view: { classification: kind, recovery: false } };
  } finally {
    lock.release();
  }
}

/** The seat was made ready under this run's feet, by the coordinator's `team answer`. */
function ready(seat: string): PauseResult {
  return { kind: 'ready', detail: `  ${seat} was answered while its prompt was open; it is ready\n` };
}
