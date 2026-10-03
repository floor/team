import type { Profile } from './profile.ts';

/**
 * Model ids from `cursor-agent --list-models`. Effort and speed suffixes are not the team file's
 * version. Unknown ids stay unread.
 */
export function cursorModel(id: string): { model: string; version: string } | null {
  const match = /^(?:cursor-)?grok-(\d+(?:\.\d+)*)(?:-(?:xhigh|high|medium|low)(?:-fast)?|-fast)?$/i.exec(id);
  const version = match?.[1];
  return version ? { model: 'Grok', version } : null;
}

/**
 * Cursor Agent 2026.10.01: `--force` and `--sandbox disabled` from `--help`, passed as launch
 * arguments. Screens and `/exit` from a scratch session. `--trust` is not included: it records
 * trust for the folder, and a trust question is left unanswered.
 */
export const cursor: Profile = {
  cli: 'cursor',
  processNames: ['cursor-agent'],
  binary: 'cursor-agent',
  tested: { from: '2026.10.01', to: '2026.10.01' },
  unattended: ['--force', '--sandbox', 'disabled'],
  rulesOption: null,
  loginCheck: ['status'],
  loginHint: 'cursor-agent login',
  exit: '/exit',
  idleTimeout: 90,
  exitTimeout: 30,
  modelOf(launch) {
    const match = /(?:^|\s)--model(?:=|\s+)(\S+)/.exec(launch);
    const id = match?.[1];
    return id ? cursorModel(id) : null;
  },
};
