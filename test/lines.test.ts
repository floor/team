import { describe, expect, test } from 'bun:test';
import { clearStopped, restoreSeat, rewriteCount, seatIsStopped } from '../src/file/lines.ts';

const counted = `format: 1
seats:
  - role: implementer
    name: deepseek
    label: deepseek
    count: 2
    stopped: true
    # kept with the entry
    cli: claude-code
  - role: coordinator
    name: lead
    cli: claude-code
`;

describe('the line-level writer', () => {
  test('a count entry becomes explicit seats, and the comment stays', () => {
    const text = rewriteCount(counted, 'deepseek');
    expect(text).not.toBeNull();
    expect(text).toContain('# kept with the entry');
    expect(text).not.toContain('count:');
    expect(text).toContain('name: deepseek\n');
    expect(text).toContain('name: deepseek-2');
    expect(text).toContain('label: deepseek-2');
    expect(text).toContain('name: lead');
    expect(text?.match(/cli: claude-code/g)).toHaveLength(3);
  });

  test('clearing one stopped instance leaves the other stopped', () => {
    const text = clearStopped(counted, 'deepseek-2');
    expect(seatIsStopped(text, 'deepseek')).toBe(true);
    expect(seatIsStopped(text, 'deepseek-2')).toBe(false);
    expect(text).toContain('# kept with the entry');
    expect(text).toContain('name: lead');
  });

  test('a missing seat is put back from the approved copy, beside the neighbour that remains', () => {
    const current = counted.replace(/ {2}- role: implementer[\s\S]*?cli: claude-code\n/, '');
    expect(current).not.toContain('deepseek');
    const restored = restoreSeat(current, counted, 'deepseek-2');
    expect(restored).toContain('name: deepseek');
    expect(restored).toContain('count: 2');
    expect(restored.indexOf('name: deepseek')).toBeLessThan(restored.indexOf('name: lead'));
    expect(restored).toContain('# kept with the entry');
  });
});
