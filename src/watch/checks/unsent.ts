import { reported, type SeatCheck } from '../check.ts';

// Text held in the composer that was never sent: a seat herdr calls idle, holding a sentence. It
// is reported once the text has stood there for `unsent_after`, and its clock clears the moment
// the seat is anything else — running, at a prompt, or holding nothing.
export const unsent: SeatCheck = {
  name: 'unsent',
  run(seat, ctx) {
    const since = ctx.memory<Record<string, number>>('unsent', () => ({}));
    if (!seat.running || !seat.quiet || seat.working || seat.prompt || seat.screen.kind !== 'unsent') {
      delete since[seat.name];
      return [];
    }
    since[seat.name] ??= ctx.now;
    if (ctx.now - (since[seat.name] as number) < ctx.watch.unsentAfter * 1000) return [];
    return reported(ctx.once(`unsent:${seat.name}`, `${seat.name} holds text in its input box that was never sent`));
  },
};
