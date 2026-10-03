import type { Profile } from './profile.ts';

/** Model spellings verified by the CLI and the team-file contract. Unknown ids stay unread. */
export function codexModel(id: string): { model: string; version: string } | null {
  const match = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|luna|terra)$/i.exec(id);
  if (!match) return null;
  const family = match[2] as string;
  return { model: `GPT ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`, version: match[1] as string };
}

/** Codex 0.157.0: launch flags from --help; screens and /exit from a scratch session. */
export const codex: Profile = {
  cli: 'codex',
  processNames: ['codex'],
  binary: 'codex',
  tested: { from: '0.157.0', to: '0.157.0' },
  unattended: ['-a', 'never', '-s', 'danger-full-access'],
  rulesOption: null,
  loginCheck: ['login', 'status'],
  loginHint: 'codex login',
  exit: '/exit',
  idleTimeout: 90,
  exitTimeout: 30,
  modelOf(launch) {
    const match = /(?:^|\s)(?:-m|--model)[= ]([^\s]+)(?=\s|$)/.exec(launch);
    return match ? codexModel(match[1] as string) : null;
  },
};
