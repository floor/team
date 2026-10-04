import { reported, type TeamCheck } from '../check.ts';

// Load per core above the file's maximum. A figure that wasn't read is never reported.
export const load: TeamCheck = {
  name: 'load',
  run(team, ctx) {
    const value = team.machine.loadPerCore;
    if (value === null || value <= team.limits.loadMax) return [];
    return reported(ctx.once('load', `the load is ${value.toFixed(1)} per core, above ${team.limits.loadMax}`, 'owner'));
  },
};
