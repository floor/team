import type { Seat } from './types.ts';

// The model the file declares, in the one spelling every line that names it uses: the seat's
// `display` — the vendor's spelling when the file sets one, and `model version` otherwise, as
// the loader computes it (sections/seats.ts). `status`'s table and difference line, `doctor`'s
// findings and the watch's drift notice all name the declared model through here, so a seat
// with a `display` is spelled the same everywhere.
export function declaredModel(seat: Pick<Seat, 'display'>): string {
  return seat.display;
}
