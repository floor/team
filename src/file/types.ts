export type Problem = { line: number; message: string };

export type Position = 'last-line' | 'trailer' | 'anywhere';
export type Mode = 'worktree' | 'shared';

export type BudgetSource = 'check' | 'status_line';

export type BudgetAccount = {
  kind: 'subscription' | 'spend';
  shared: boolean;
  /** Percent left that is held back. Null on a spend account. */
  reserve: number | null;
  /** Money still required on a spend account. Null on a subscription. */
  floor: { amount: number; currency: string } | null;
  sources: BudgetSource[];
  /** The command `check` names, or null when the account has no check. */
  check: string | null;
};

export type Seat = {
  role: string;
  name: string;
  cli: string;
  vendor: string;
  model: string;
  version: string;
  display: string;
  launch: string;
  cwd: string;
  label: string;
  mode: Mode;
  parked: boolean;
  stopped: boolean;
  // The entry's `name` and `count` as written, and this seat's place in it (1 for the first).
  declared: string;
  count: number;
  instance: number;
  line: number;
};

export type TeamFile = {
  format: 1;
  project: string;
  visibility: 'public' | 'private';
  session: string;
  coordinator: string;
  operator: string;
  tools: Record<string, Record<string, string>>;
  identity: {
    signature: {
      commits: { template: string; position: Position; exempt: 'merge'[] };
      pullRequests: { template: string; position: Position };
    };
    humans: string[];
    since: string | null;
    // The two defaults first, then the file's own.
    forbidden: string[];
    forbiddenPublic: string[];
  };
  rules: string[];
  trust: string[];
  workspace: {
    mode: Mode;
    path: string | null;
    branch: string;
    base: string | null;
    setup: string[];
    remove: 'on-merge' | 'manual';
    protected: string[];
    limit: number;
  };
  // Durations in seconds.
  watch: {
    interval: number;
    idleFirst: number;
    idleRepeat: number;
    teamIdle: number;
    nudgeWait: number;
    unsentAfter: number;
    quotaMarks: number[];
  };
  budgets: {
    staleAfter: number;
    checkEvery: number;
    marks: number[];
    accounts: Record<string, BudgetAccount>;
  };
  // Load per core, memory in percent free, disk and swap in bytes, the window in seconds.
  machine: {
    loadStart: number;
    loadMax: number;
    memoryStart: number;
    memoryMin: number;
    diskMin: number;
    swapFreeMin: number;
    swapGrowthMax: number;
    swapGrowthWindow: number;
  };
  limits: { seats: number; temporary: number; vendors: Record<string, number> };
  // After `count` is expanded.
  seats: Seat[];
};

export type ValidateResult =
  | { ok: true; team: TeamFile; warnings: Problem[] }
  | { ok: false; errors: Problem[] };

export type LoadResult =
  | { ok: true; team: TeamFile; root: string; path: string; warnings: Problem[]; text: string }
  | { ok: false; errors: Problem[]; path?: string };
