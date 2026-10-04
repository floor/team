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
  trust?: (lines: string[]) => boolean;
  permission?: (lines: string[]) => boolean;
  question?: (lines: string[]) => boolean;
  working?: (lines: string[]) => boolean;
  composer?: (lines: string[]) => ComposerReading;
}
