import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readMerge } from '../end/condition.ts';

export type EndView =
  | { kind: 'result'; exists: boolean }
  | { kind: 'merged'; verdict: 'merged' | 'open' | 'unproven'; detail: string; ownNow: number };

/** What the watch reads for one end. A missing base cannot prove a merge. */
export function readEnd(root: string, until: string, base: string | null, ownBefore: boolean): EndView {
  if (until.startsWith('result:') && until.length > 'result:'.length) {
    return { kind: 'result', exists: existsSync(resolve(root, until.slice('result:'.length))) };
  }
  if (!until.startsWith('merged:') || until.length <= 'merged:'.length) {
    return { kind: 'merged', verdict: 'unproven', ownNow: 0, detail: 'the end is not one this version reads; nothing is removed' };
  }
  if (!base) {
    return { kind: 'merged', verdict: 'unproven', ownNow: 0, detail: 'workspace.base is required to read a merged end; nothing is removed' };
  }
  const read = readMerge(root, until.slice('merged:'.length), base, ownBefore);
  return { kind: 'merged', verdict: read.verdict, detail: read.detail, ownNow: read.ownNow };
}
