import { describe, expect, test } from 'bun:test';
import { judgeTemporary, judgeWorktree } from '../src/watch/close.ts';

const open = { kind: 'merged' as const, verdict: 'open' as const, detail: 'the branch never had a commit of its own', ownNow: 0 };
const merged = { kind: 'merged' as const, verdict: 'merged' as const, detail: 'its own commits are in the base', ownNow: 0 };
const unproven = { kind: 'merged' as const, verdict: 'unproven' as const, detail: 'the fetch failed; nothing is removed', ownNow: 0 };
const still = { kind: 'merged' as const, verdict: 'open' as const, detail: 'the branch still has commits of its own', ownNow: 2 };

describe('the watch closing a temporary seat', () => {
  test('a result that exists closes a free seat that has worked', () => {
    expect(judgeTemporary({ worked: true, free: true, ownBefore: false, end: { kind: 'result', exists: true } }).close).toBe(true);
    expect(judgeTemporary({ worked: false, free: true, ownBefore: false, end: { kind: 'result', exists: true } }).close).toBe(false);
    expect(judgeTemporary({ worked: true, free: false, ownBefore: false, end: { kind: 'result', exists: true } }).close).toBe(false);
    expect(judgeTemporary({ worked: true, free: true, ownBefore: false, end: { kind: 'result', exists: false } }).close).toBe(false);
  });

  test('merged only after an earlier pass saw commits of the branch\'s own', () => {
    expect(judgeTemporary({ worked: true, free: true, ownBefore: false, end: merged }).close).toBe(false);
    expect(judgeTemporary({ worked: true, free: true, ownBefore: true, end: merged }).close).toBe(true);
    expect(judgeTemporary({ worked: true, free: true, ownBefore: false, end: open }).close).toBe(false);
    const seen = judgeTemporary({ worked: true, free: true, ownBefore: false, end: still });
    expect(seen.close).toBe(false);
    expect(seen.ownCommits).toBe(true);
    expect(seen.report).toBeUndefined();
    const squash = judgeTemporary({
      worked: true, free: true, ownBefore: true,
      end: { kind: 'merged', verdict: 'open', detail: 'merged? not provable', ownNow: 1 },
    });
    expect(squash.close).toBe(false);
    expect(squash.report).toBe('merged? not provable');
    expect(judgeTemporary({ worked: true, free: true, ownBefore: true, end: unproven }).report).toContain('fetch failed');
  });
});

describe('the watch removing a merged worktree', () => {
  test('on-merge, once the branch had commits of its own and now has none, and no seat is in it', () => {
    expect(judgeWorktree({ policy: 'manual', occupied: false, ownBefore: true, end: merged }).close).toBe(false);
    expect(judgeWorktree({ policy: 'on-merge', occupied: true, ownBefore: true, end: merged }).close).toBe(false);
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: false, end: merged }).close).toBe(false);
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: true, end: merged }).close).toBe(true);
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: false, end: still }).ownCommits).toBe(true);
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: false, end: still }).report).toBeUndefined();
    expect(judgeWorktree({
      policy: 'on-merge', occupied: false, ownBefore: true,
      end: { kind: 'merged', verdict: 'open', detail: 'merged? not provable', ownNow: 1 },
    }).report).toBe('merged? not provable');
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: true, end: unproven }).report).toContain('fetch failed');
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: false, end: open }).close).toBe(false);
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: false, end: open }).report).toBeUndefined();
  });
});
