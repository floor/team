import type { CheckConfig, SeatIdentity } from '../../src/check/config.ts'
import { HUMAN_EMAIL } from './repository.ts'

export const OPUS: SeatIdentity = {
  display: 'Claude Opus 5.5',
  role: 'implementer',
  model: 'Claude Opus',
  version: '5.5',
}

export const SOL: SeatIdentity = {
  display: 'GPT-6 Sol',
  role: 'reviewer',
  model: 'GPT Sol',
  version: '6',
}

export const SIGNATURE = 'Agent: Claude Opus 5.5 · implementer'
export const PR_SIGNATURE = '**Agent:** Claude Opus 5.5 · implementer'

/** The file's defaults, a public project, two seats and one human. */
export function config(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    public: true,
    commits: { template: 'Agent: {display} · {role}', position: 'trailer', exemptMerge: true },
    pullRequests: { template: '**Agent:** {display} · {role}', position: 'last-line' },
    humans: [HUMAN_EMAIL],
    forbidden: [],
    forbiddenPublic: ['\\bWEB-[0-9]+\\b'],
    ledger: [OPUS, SOL],
    ...overrides,
  }
}
