import type { SeatCheck } from '../check.ts';

// A seat the file holds that no agent answers for. A stopped seat is not started: absent from
// herdr is its normal state, and draws nothing. And when the session itself doesn't answer, every
// seat is absent for the same reason — the watch reports none of them.
//
// A seat this watch has seen running is not the same condition as one it never saw: the line tells
// which. The told mark drops when the seat is seen running again — as the idle check's mark does —
// so each disappearance is reported, not only the first.
export const missing: SeatCheck = {
  name: 'missing',
  run(seat, ctx) {
    const seen = ctx.memory<Record<string, true>>('missing-seen', () => ({}));
    const told = ctx.memory<Record<string, true>>('missing-told', () => ({}));
    if (seat.running) {
      seen[seat.name] = true;
      delete told[seat.name];
      return [];
    }
    if (seat.stopped || !seat.herdr) {
      delete told[seat.name];
      return [];
    }
    if (told[seat.name]) return [];
    told[seat.name] = true;
    return [{
      key: `missing:${seat.name}`,
      text: seen[seat.name]
        ? `${seat.name} was running and is gone (its pane closed, or its CLI ended)`
        : `${seat.name} is in the file and is not running`,
      to: 'operator',
    }];
  },
};
