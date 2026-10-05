// One progress record per seat, and the writer that draws it.
//
// `up` and `add` work one seat at a time, and a seat's line is the run's whole account of it:
// `<seat>: launching`, rewritten in place while the seat advances, until its one final record.
// On a terminal the line is drawn before the seat's workspace is created and rewritten with a
// carriage return and a clear to the end of the line — never a cursor move to another line — and
// the final record ends with a newline. A redirected stdout receives only the final records, one
// newline-terminated line per seat, in file order: no provisional text, no carriage return, no
// escape sequence. Everything else a run says — refusals, notes, the timeout's last reading, what
// the owner does next — is on stderr, after the record it belongs to.
//
// The record is the unit the next slice builds on: a pause at a dialog is a `waiting for owner`
// record, carried here so the type and the log already know it, printed by nothing yet.
//
// The writer cleans every string it writes (`plainText`): it is the boundary between whatever a
// caller built — a seat name, a live stage word, a reason read off a screen — and the terminal.

import { plainText } from './plain.ts';

/** The classifications a record can name. `login` is reserved: no profile produces it today. */
export type Classification =
  | 'trust'
  | 'permission'
  | 'question'
  | 'vendor notice'
  | 'login'
  | 'unknown'
  | 'unsent'
  | 'timeout';

/** The provisional states a line is drawn in, in the order a seat can pass them. The words a
 *  person watching the terminal sees. */
export type ProgressState = 'launching' | 'waiting for its prompt' | 'naming' | 'sending its rules';

/** A seat's final record. `waiting for owner` belongs to the next slice: the record type carries
 *  it and the log accepts it; `up` and `add` print neither today. */
export type FinalRecord =
  | { kind: 'ready' }
  | { kind: 'left out'; reason: string }
  | { kind: 'waiting for owner'; classification: Classification };

/** The record as a line, without its newline. */
export function recordText(seat: string, record: FinalRecord): string {
  if (record.kind === 'ready') return `${seat}: ready`;
  if (record.kind === 'left out') return `${seat}: left out: ${record.reason}`;
  return `${seat}: waiting for owner (${record.classification})`;
}

/** What the log keeps for a record: the record's own words after the seat's name. */
export function recordWhat(record: FinalRecord): string {
  if (record.kind === 'ready') return 'ready';
  if (record.kind === 'left out') return `left out: ${record.reason}`;
  return `waiting for owner (${record.classification})`;
}

export type ProgressSink = {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdout is a terminal: only then is a provisional line drawn. */
  isTTY: boolean;
};

export type Progress = {
  /** The seat's line, first drawn before its workspace is created and rewritten as it advances.
   *  On a redirected stdout this writes nothing at all. */
  progress(seat: string, state: ProgressState): void;
  /** The seat's one final record — the newline-terminated line — and, after it, the detail the
   *  run says about it: the lines are written to stderr verbatim, already indented. */
  final(seat: string, record: FinalRecord, detail: string): void;
};

/** The writer `up` and `add` hand their host. One per run. */
export function progressWriter(sink: ProgressSink): Progress {
  // The writer is the boundary: whatever a caller hands it, the seat, the stage word, the
  // reason and every detail line are cleaned here (`plainText`, the cleaning pane excerpts are
  // built on), so no escape sequence or carriage return a caller slipped in can reach the
  // terminal, a pipe, or a log that copies the record. A seat, a stage word or a reason the
  // cleaning leaves empty is said as `unknown`: the one line per seat survives a caller that
  // said nothing readable, and the word is the one these records already use for a reading this
  // version cannot make. The detail keeps its line breaks and is never cut: the cut belongs to
  // pane excerpts, not to a record or a note.
  const said = (text: string): string => plainText(text) || 'unknown';
  return {
    progress(seat, state) {
      // Redirected: the final records only. Nothing provisional ever reaches a pipe.
      if (!sink.isTTY) return;
      sink.stdout(`\r\x1b[K${said(seat)}: ${said(state)}`);
    },
    final(seat, record, detail) {
      const clean: FinalRecord =
        record.kind === 'left out' ? { kind: 'left out', reason: said(record.reason) } : record;
      const text = recordText(said(seat), clean);
      sink.stdout(sink.isTTY ? `\r\x1b[K${text}\n` : `${text}\n`);
      const rest = plainText(detail);
      if (rest !== '') sink.stderr(rest);
    },
  };
}
