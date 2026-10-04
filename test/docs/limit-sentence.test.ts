// The owner's decision, word for word: what approvals are for is said in one sentence, and it
// stands in both places that state it — the README and the approve page. A rewrite of either
// (round 2's honesty pass lost it from one) may reword what surrounds it, never this sentence.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const SENTENCE = 'Approvals guard against mistakes, not against a hostile process running as the owner.';

// Whitespace runs collapse before the match, so the sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('the limit sentence', () => {
  test('the README and the approve page carry it, verbatim', () => {
    for (const path of ['../../README.md', '../../docs/commands/approve.md']) {
      expect(prose(path).includes(SENTENCE), `${path} lost the limit sentence`).toBe(true);
    }
  });
});
