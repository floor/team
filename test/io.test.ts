// `cleanedIo`: a command takes it once at its entry, and every line it then writes is cleaned
// with the one cleaning before it reaches the terminal. The progress writer alone keeps the raw
// writers: it draws its own `\r\x1b[K` on a TTY and cleans its own fields.
import { describe, expect, test } from 'bun:test';
import { cleanedIo, type Io } from '../src/io.ts';
import { plainLine } from '../src/launch/plain.ts';

function pair(): { written: string[]; clean: Io } {
  const written: string[] = [];
  const io: Io = {
    stdout: (text) => written.push(text),
    stderr: (text) => written.push(text),
    cwd: '/x',
    env: {},
    stdinIsTTY: false,
  };
  return { written, clean: cleanedIo(io) };
}

describe('cleanedIo', () => {
  test('each line is cleaned with the one cleaning, and the line structure is kept', () => {
    const { written, clean } = pair();
    clean.stdout('a\x1b[31mb\nsecond\u2028line\n');
    clean.stderr('one\r two');
    expect(written[0]).toBe('ab\nsecond line\n');
    expect(written[1]).toBe('one two');
  });

  test('an ordinary string is byte for byte what it was, trailing newline included', () => {
    const { written, clean } = pair();
    const ordinary = 'team up: worker is already running\n  note: its launch line runs `x`\n';
    clean.stdout(ordinary);
    clean.stdout('no trailing newline');
    expect(written[0]).toBe(ordinary);
    expect(written[1]).toBe('no trailing newline');
  });

  test('a value cleaned at the call site and again here is, in effect, cleaned once', () => {
    // `up` and `add` keep the per-call cleaning that folds a value to one line, and the entry
    // cleaning runs again over its output: the cleaning is idempotent, so nothing changes.
    const dirty = 'a\x1b[31mb\u00adc\u2028d\r';
    const once = pair();
    once.clean.stdout(plainLine(dirty));
    const twice = pair();
    twice.clean.stdout(plainLine(plainLine(dirty)));
    expect(once.written[0]).toBe('abc d');
    expect(twice.written[0]).toBe(once.written[0]);
  });

  test('a JSON document the encoder made is untouched, and stays valid JSON', () => {
    // The decision: JSON output is not cleaned. `up` and `add` write no JSON at all (`--json` is
    // status, answer and release only), and the writers those three use keep the raw pair — a
    // document is for a parser, not for the terminal, so the cleaning's rule does not apply to it.
    // Cleaning it would corrupt it, too: the encoder escapes every control byte (`node -e
    // 'JSON.stringify({r:"a\u001bb"})'` prints `{"r":"a\u001bb"}`, an escape byte as six ASCII
    // characters), but not every invisible one — U+00AD is printed raw (a run this round), and the
    // cleaning would delete it from the value. The encoder alone is trusted with this text.
    const { written, clean } = pair();
    const document = JSON.stringify({ reason: 'a\x1bb', name: 'worker' });
    clean.stdout(document);
    expect(written[0]).toBe(document);
    expect(JSON.parse(written[0]!).reason).toBe('a\x1bb');
  });
});
