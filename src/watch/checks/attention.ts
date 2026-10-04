import { reported, type SeatCheck } from '../check.ts';

// The one exclusive reading the core made of the seat's screen and status: a seat waits at a
// permission prompt its owner has to answer, asks a question the operator has to act on, is
// blocked on a screen the watch doesn't recognise, or reports a status the watch doesn't know.
// A permission prompt and a trust question are the same seat state to the watch.
export const attention: SeatCheck = {
  name: 'attention',
  run(seat, ctx) {
    if (seat.attention === 'permission') {
      return reported(ctx.once(`blocked:${seat.name}`, `${seat.name} waits at a permission prompt: its owner's to answer`, 'owner'));
    }
    if (seat.attention === 'question') {
      return reported(ctx.once(`question:${seat.name}`, `${seat.name} asked a question: the operator's to act on`));
    }
    if (seat.attention === 'blocked') {
      return reported(ctx.once(`blocked:${seat.name}`, `${seat.name} is blocked, and its screen is not one the watch recognises`, 'owner'));
    }
    if (seat.attention === 'unknown' && seat.agent) {
      return reported(ctx.once(`unknown:${seat.name}`, `${seat.name}: herdr reports the status "${seat.agent.status}"`));
    }
    return [];
  },
};
