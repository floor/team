import type { Profile } from './profile.ts';

/** Model spellings verified by the CLI and the team-file contract. Unknown ids stay unread. */
export function antigravityModel(id: string): { model: string; version: string } | null {
  const match = /^gemini-(\d+(?:\.\d+)?)-(flash|pro)(?:-(high|medium|low))?$/i.exec(id);
  if (!match) return null;
  const family = match[2] as string;
  return {
    model: `Gemini ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`,
    version: match[1] as string,
  };
}

/** Antigravity (agy) 1.2.16: launch flags from --help; screens and /exit from a scratch session. */
export const antigravity: Profile = {
  cli: 'antigravity',
  processNames: ['agy'],
  binary: 'agy',
  tested: { from: '1.2.16', to: '1.2.16' },
  unattended: ['--dangerously-skip-permissions'],
  rulesOption: null,
  loginCheck: ['models'],
  loginHint: 'agy',
  exit: '/exit',
  idleTimeout: 90,
  exitTimeout: 30,
  modelOf(launch) {
    const match = /(?:^|\s)--model[= ]([^\s]+)(?=\s|$)/.exec(launch);
    return match ? antigravityModel(match[1] as string) : null;
  },
};
