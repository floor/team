/** What the rules of a seat are written from. */
export interface RulesInput {
  coordinator: string;
  /** The file's own `rules`. */
  rules: readonly string[];
  /** The seat's signature lines, already rendered. */
  signature: { commit: string; pullRequest: string; commitPosition: 'last-line' | 'trailer' | 'anywhere' };
  workspace: {
    mode: 'worktree' | 'shared';
    protected: readonly string[];
    branch?: string;
  };
}

const COMMIT_PLACE: Record<RulesInput['signature']['commitPosition'], string> = {
  trailer: 'as a trailer, in a last paragraph of its own that holds trailers only',
  'last-line': 'as its last line',
  anywhere: 'on a line of its own',
};

/**
 * The rules a seat gets at launch, one per line, in this order: the profile's
 * own (what `team` itself depends on), the file's, the seat's signature, the
 * workspace's.
 */
export function seatRules(input: RulesInput): string[] {
  const { signature, workspace } = input;
  const own = [
    'End every commit message and every pull request body with your signature, given below.',
    `Never stop at a question: tell the coordinator (${input.coordinator}) in one line and keep working.`,
    'Never run `team trust` or `team approve`, and never edit `trust:` in the team file.',
    'In a protected checkout, never switch the branch, reset or commit.',
  ];
  const signing = [
    `Your signature in a commit message, ${COMMIT_PLACE[signature.commitPosition]}: ${signature.commit}`,
    `Your signature in a pull request body, as its last line: ${signature.pullRequest}`,
  ];
  const working: string[] = [];
  if (workspace.protected.length > 0) {
    working.push(`Protected checkouts, relative to the project root: ${workspace.protected.join(', ')}`);
  }
  if (workspace.mode === 'worktree') {
    working.push(
      'Work on the code in the worktree your brief names, never in the checkout you started in.' +
        (workspace.branch ? ` Branches are named ${workspace.branch}.` : ''),
    );
  }
  return [...own, ...input.rules, ...signing, ...working];
}

/** The rules as the one text a launch option or a first message carries. */
export function rulesText(input: RulesInput): string {
  return ['Rules for this session, from the team file:', ...seatRules(input).map((rule) => `- ${rule}`)].join('\n');
}
