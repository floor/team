import { gb } from '../machine.ts';
import { reported, type TeamCheck } from '../check.ts';

// Free disk below the file's minimum, on the project's volume. A figure that wasn't read is
// never reported.
export const disk: TeamCheck = {
  name: 'disk',
  run(team, ctx) {
    const value = team.machine.diskFree;
    if (value === null || value >= team.limits.diskMin) return [];
    return reported(ctx.once('disk', `free disk is ${gb(value)}, below ${gb(team.limits.diskMin)}`, 'owner'));
  },
};
