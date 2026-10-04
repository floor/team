// An escape hatch for a CLI whose screens the data primitives cannot express.
// Stage order and the safety floor are the core's own and never weaken.
import type { Screen } from './screen.ts';

export type ComposerReading = {
  kind: Screen['kind'];
  from?: number;
  input?: number;
};

/**
 * Every hatch predicate is monotone toward caution, running alongside the data stage for unknown, trust, permission, question, and working so a hatch can only add caution, never remove it.
 * A composer comes from data or from the hatch, never both, and a profile that has a data composer while its screen_module exports a composer is refused at load.
 * The guarantees cover what a hatch returns and what load accepts; a hatch is trusted package code, not a sandbox.
 */
export interface ScreenProfile {
  unknown?: (lines: string[]) => boolean;
  trust?: (lines: string[]) => boolean;
  permission?: (lines: string[]) => boolean;
  question?: (lines: string[]) => boolean;
  working?: (lines: string[]) => boolean;
  composer?: (lines: string[]) => ComposerReading;
}
