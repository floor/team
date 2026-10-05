import type { TeamFile } from './types.ts';

/**
 * The trust dialog policy in force. The one place the answer is written down: `up` (which asks
 * the owner itself), `answer` (which refuses when it is not `coordinator`) and `status` (whose
 * repair line differs) all read it through here, so a file the validator never saw — one with no
 * `dialogs:` section at all — still reads as `owner`, the safe default.
 */
export function trustPolicy(team: Pick<TeamFile, 'dialogs'> | { dialogs?: TeamFile['dialogs'] }): 'owner' | 'coordinator' {
  return team.dialogs?.trust ?? 'owner';
}
