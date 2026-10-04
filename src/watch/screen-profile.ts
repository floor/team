// An escape hatch for a CLI whose screens the data primitives cannot express.
// Stage order and the safety floor are the core's own and never weaken.
import type { Screen } from './screen.ts';

export type ComposerReading = {
  kind: Screen['kind'];
  from?: number;
  input?: number;
};

export interface ScreenProfile {
  unknown?: (lines: string[]) => boolean;
  /**
   * Predicate for the workspace trust stage.
   * With a hatch trust returning false on a real trust dialog, the screen
   * reads question (a later stage wins): that is the hatch's own answer
   * under the rule that exactly true matches and exactly false misses.
   * The safety floor's guarantee holds: a dialog never reads idle or unsent.
   */
  trust?: (lines: string[]) => boolean;
  permission?: (lines: string[]) => boolean;
  question?: (lines: string[]) => boolean;
  working?: (lines: string[]) => boolean;
  composer?: (lines: string[]) => ComposerReading;
}
