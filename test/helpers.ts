import type { Caller } from '../src/caller.ts';
import type { Io } from '../src/io.ts';

export type TestIo = Io & { out: string; err: string };

/** A Claude Code pane with `text` in its composer: the prompt row, continuation rows at the
 *  two-column indent the profile describes, between the rules, with the status footer. The shape
 *  the watch's own screens use, for tests that type text and read the box back. */
export function claudeBox(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const rule = '─'.repeat(40);
  const status = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  return [rule, `❯ ${first}`, ...rest.map((line) => `  ${line}`), rule, status].join('\n') + '\n';
}

/** Greedy word wrap at a content width: as many words as fit on one row, the rest on the next —
 *  how a pane breaks a line wider than its text column. The captured Cursor frame is this wrap of
 *  its sentence at the pane's content width. */
export function wordWrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let row = '';
    for (const word of line.split(' ')) {
      if (row === '') row = word;
      else if (row.length + 1 + word.length <= width) row += ` ${word}`;
      else { rows.push(row); row = word; }
    }
    rows.push(row);
  }
  return rows;
}

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
