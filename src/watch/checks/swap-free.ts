import { gb } from '../machine.ts';
import { reported, type TeamCheck } from '../check.ts';

// Free swap below the file's minimum. A machine with no swap reads none, and reports nothing.
export const swapFree: TeamCheck = {
  name: 'swap-free',
  run(team, ctx) {
    const value = team.machine.swapFree;
    if (value === null || value >= team.limits.swapFreeMin) return [];
    return reported(ctx.once('swap-free', `free swap is ${gb(value)}, below ${gb(team.limits.swapFreeMin)}`, 'owner'));
  },
};
