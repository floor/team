import { reported, type SeatCheck } from '../check.ts';

// A seat the file holds that no agent answers for. A stopped seat is not started: absent from
// herdr is its normal state, and draws nothing. And when the session itself doesn't answer, every
// seat is absent for the same reason — the watch reports none of them.
export const missing: SeatCheck = {
  name: 'missing',
  run(seat, ctx) {
    if (seat.running || seat.stopped || !seat.herdr) return [];
    return reported(ctx.once(`missing:${seat.name}`, `${seat.name} is in the file and is not running`));
  },
};
