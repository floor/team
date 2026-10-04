// An escape hatch for a CLI whose screens the data primitives cannot express.
// Stage order and the safety floor are the core's own and never weaken.
import type { Screen } from './screen.ts';

export type ComposerReading = {
  kind: Screen['kind'];
  from?: number;
  input?: number;
};

/**
 * A hatch can add a dialog, never take one away: for unknown, trust, permission, and question,
 * the profile's data stage always runs and matches if the data stage matches or the hatch predicate
 * returns exactly true. Working and composer may be supplied by the hatch in place of data, but they
 * run after the dialog stages and the floor, and a composer reading never overrides a dialog found
 * by a stage or by the floor.
 */
export interface ScreenProfile {
  unknown?: (lines: string[]) => boolean;
  trust?: (lines: string[]) => boolean;
  permission?: (lines: string[]) => boolean;
  question?: (lines: string[]) => boolean;
  working?: (lines: string[]) => boolean;
  composer?: (lines: string[]) => ComposerReading;
}
