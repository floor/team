import { reported, type TeamCheck } from '../check.ts';

// Free memory below the file's minimum, in percent. A figure that wasn't read is never reported.
export const memory: TeamCheck = {
  name: 'memory',
  run(team, ctx) {
    const value = team.machine.memoryFree;
    if (value === null || value >= team.limits.memoryMin) return [];
    return reported(ctx.once('memory', `free memory is ${Math.round(value)}%, below ${team.limits.memoryMin}%`, 'owner'));
  },
};
