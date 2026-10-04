import { gb, recordSwap, type SwapSample } from '../machine.ts';
import { minutes, reported, type TeamCheck } from '../check.ts';

// Swap that grew inside the window, even while free swap is high: the growth is the pressure.
// The samples are this check's own memory, shared with nothing. A figure that wasn't read is
// never reported.
export const swapGrowth: TeamCheck = {
  name: 'swap-growth',
  run(team, ctx) {
    const used = team.machine.swapUsed;
    if (used === null) return [];
    const samples = ctx.memory<SwapSample[]>('swap-growth', () => []);
    const growth = recordSwap(samples, used, ctx.now, team.limits.swapGrowthWindow);
    if (growth <= team.limits.swapGrowthMax) return [];
    return reported(ctx.once(
      'swap-growth',
      `swap grew by ${gb(growth)} in ${minutes(team.limits.swapGrowthWindow * 1000)} minutes, above ${gb(team.limits.swapGrowthMax)}`,
      'owner',
    ));
  },
};
