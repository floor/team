import { reported, type SeatCheck } from '../check.ts';

// A seat whose pane no longer holds the process team launched: its session was restored by
// something else, or its CLI was restarted by hand. Whatever runs in the pane now is not the
// seat — its model, account and rules are not the ones team delivered, and a brief sent to it
// would be done by another process. Reported at the first pass that reads it, and again only
// after the seat was the seat once more and stopped being it anew (the report-once rule).
export const restored: SeatCheck = {
  name: 'restored',
  run(seat, ctx) {
    if (seat.identity !== 'gone' && seat.identity !== 'replaced') return [];
    return reported(
      ctx.once(
        `restored:${seat.name}`,
        `${seat.name} is no longer the process team launched (its session was restored, or its CLI was restarted)`,
      ),
    );
  },
};
