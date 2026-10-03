import { claudeCode } from './claude-code.ts';
import type { Profile } from './profile.ts';

/** The profiles this version launches. A `cli` without one is reported and left out. */
const PROFILES: Record<string, Profile> = {
  'claude-code': claudeCode,
};

export function profileFor(cli: string): Profile | null {
  return Object.hasOwn(PROFILES, cli) ? (PROFILES[cli] ?? null) : null;
}
