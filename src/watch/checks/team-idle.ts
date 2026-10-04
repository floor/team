import type { TeamCheck } from '../check.ts';

// Every worker idle at once, reported once per idle stretch, after `team_idle`. A worker that
// works again re-arms it. The leads and parked seats never count as the team's workers.
export const teamIdle: TeamCheck = {
  name: 'team-idle',
  run(team, ctx) {
    const memory = ctx.memory<{ since: number | null; told: boolean }>('team-idle', () => ({ since: null, told: false }));
    if (!team.workers.length || !team.workers.every((worker) => worker.idle)) {
      memory.since = null;
      memory.told = false;
      return [];
    }
    memory.since ??= ctx.now;
    if (memory.told || ctx.now - memory.since < ctx.watch.teamIdle * 1000) return [];
    memory.told = true;
    return [{ key: 'team-idle', text: 'every agent is idle', to: 'operator' }];
  },
};
