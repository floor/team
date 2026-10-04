import { reported, type SeatCheck } from '../check.ts';

// A seat that runs a model other than the one the file declares: what it signs with is not what
// the owner approved. A temporary seat has no file model, and a screen the profile cannot read is
// unread, never a mismatch.
export const modelDrift: SeatCheck = {
  name: 'model-drift',
  run(seat, ctx) {
    const file = seat.seat;
    const running = seat.model;
    if (!file || !running || (running.model === file.model && running.version === file.version)) return [];
    return reported(ctx.once(
      `model:${seat.name}`,
      `${seat.name} runs ${running.model} ${running.version}; the file says ${file.model} ${file.version}: it signs with the wrong model`,
    ));
  },
};
