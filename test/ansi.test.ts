import { describe, expect, test } from 'bun:test';
import { sgrDim } from '../src/ansi.ts';

// The faint state one SGR sequence leaves the pen in, from false and from faint. Faint is
// the only placeholder style: every colour, however grey it renders, leaves the pen plain.
// The extended-colour forms carry their payload in sub-parameters (38/48/58, then 5;n or
// 2;r;g;b): a `2` in there is a colour's own number, never the faint switch.
describe('sgrDim', () => {
  const cases: [string, boolean, boolean][] = [
    ['\x1b[2m', false, true],
    ['\x1b[2m', true, true],
    ['\x1b[0m', true, false],
    ['\x1b[22m', true, false],
    ['\x1b[m', true, false],
    ['\x1b[1m', true, true],
    ['\x1b[90m', false, false],
    ['\x1b[38;5;2m', false, false],
    ['\x1b[38;5;244m', false, false],
    ['\x1b[38;2;0;0;0m', false, false],
    ['\x1b[38;2;153;153;153m', false, false],
    ['\x1b[48;5;2m', false, false],
    ['\x1b[48;5;2m', true, true],
    ['\x1b[48;2;2;10;20m', false, false],
    ['\x1b[58;5;2m', false, false],
    ['\x1b[2;48;5;2m', false, true],
  ];
  for (const [sequence, before, after] of cases) {
    test(`\`${sequence.replace(/\x1b/g, 'ESC')}\` from ${before ? 'faint' : 'plain'} → ${after ? 'faint' : 'plain'}`, () => {
      expect(sgrDim(sequence, before)).toBe(after);
    });
  }
});
