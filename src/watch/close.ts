import type { EndView } from './end.ts';

// Whether the watch may close a temporary seat, or remove an on-merge worktree.
// A fresh branch and one whose work landed between two passes look the same, so neither is
// removed: `ownBefore` is the only record that the branch once had commits of its own.

export type CloseDecision = {
  close: boolean;
  /** Set when this pass saw commits of the branch's own. The next pass can then prove a merge. */
  ownCommits?: boolean;
  report?: string;
};

export function judgeTemporary(input: {
  worked: boolean;
  free: boolean;
  ownBefore: boolean;
  end: EndView;
}): CloseDecision {
  if (input.end.kind === 'result') {
    if (!input.end.exists || !input.worked || !input.free) return { close: false };
    return { close: true };
  }
  if (input.end.ownNow > 0) return openBranch(input.end.detail);
  if (input.end.verdict === 'unproven') return { close: false, report: input.end.detail };
  if (!input.ownBefore || !input.worked || !input.free) return { close: false };
  if (input.end.verdict === 'merged') return { close: true };
  return { close: false };
}

export function judgeWorktree(input: {
  policy: 'on-merge' | 'manual';
  occupied: boolean;
  ownBefore: boolean;
  end: EndView;
}): CloseDecision {
  if (input.policy !== 'on-merge') return { close: false };
  if (input.end.kind !== 'merged') return { close: false };
  if (input.end.ownNow > 0) return openBranch(input.end.detail);
  if (input.end.verdict === 'unproven') return { close: false, report: input.end.detail };
  if (!input.ownBefore || input.occupied) return { close: false };
  if (input.end.verdict === 'merged') return { close: true };
  return { close: false };
}

// A squash leaves commits on the branch while its tree matches the base. That is reported once,
// the same way a failed fetch is, and nothing is closed.
function openBranch(detail: string): CloseDecision {
  return {
    close: false,
    ownCommits: true,
    ...(detail.includes('not provable') ? { report: detail } : {}),
  };
}
