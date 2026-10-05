import { minutes, type SeatCheck } from '../check.ts';

// A seat that has stopped: quiet, with no running turn, no prompt and no unsent text. The
// duration counts from the last moment it was seen working. A seat never seen working was already
// idle when the watch started: it is reported that way, with no duration from another source.
// An idle seat is reported once per idle period by default; repeats are off unless `watch.idle_repeat`
// is set. The leads and parked seats are reported on, but their idle time is not the team's: skipped.
export const idle: SeatCheck = {
  name: 'idle',
  run(seat, ctx) {
    const told = ctx.memory<Record<string, number>>('idle', () => ({}));
    if (!seat.running) return [];
    if (!seat.quiet || seat.working || seat.prompt) {
      delete told[seat.name];
      return [];
    }
    if (seat.lead || seat.parked) return [];
    const worked = seat.history.lastWorking;
    const since = ctx.now - (worked ?? seat.history.idleSince ?? ctx.now);
    const at = told[seat.name];
    if (since < ctx.watch.idleFirst * 1000 || (at !== undefined && (ctx.watch.idleRepeat === undefined || ctx.now - at < ctx.watch.idleRepeat * 1000))) return [];
    told[seat.name] = ctx.now;
    return [{
      key: `idle:${seat.name}`,
      text: worked === undefined
        ? `${seat.name} has been idle since the watch started`
        : `${seat.name} has been idle for ${minutes(since)} minutes`,
      to: 'operator',
    }];
  },
};
