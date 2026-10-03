import type { Profile } from './profile.ts';

const FAMILIES: Record<string, string> = {
  opus: 'Claude Opus',
  sonnet: 'Claude Sonnet',
  haiku: 'Claude Haiku',
  fable: 'Claude Fable',
};

/**
 * Claude Code. Read from `claude --help` and `claude --version` (2.1.288):
 * `--dangerously-skip-permissions` and `--append-system-prompt`.
 */
export const claudeCode: Profile = {
  cli: 'claude-code',
  processNames: ['claude'],
  binary: 'claude',
  tested: { from: '2.1.288', to: '2.1.288' },
  unattended: ['--dangerously-skip-permissions'],
  rulesOption: '--append-system-prompt',
  exit: '/exit',
  idleTimeout: 90,
  exitTimeout: 30,
  modelOf(launch) {
    // claude-opus-5-5, claude-haiku-4-5-20251001
    const match = /(?:^|\s)--model[= ]claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?=\s|$)/.exec(launch);
    if (!match) return null;
    const [, family = '', major = '', minor] = match;
    const model = FAMILIES[family];
    if (!model) return null;
    return { model, version: minor === undefined ? major : `${major}.${minor}` };
  },
};
