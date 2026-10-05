// The shape of a profile's screen, after the dialect has compiled its patterns.
import type { ScreenProfile } from './screen-profile.ts';
import type { Screen } from './screen.ts';

export type LinePattern = { match: RegExp; except: RegExp[] };

export type Rule = {
  any?: LinePattern[];
  all?: LinePattern[];
  footer?: string;
  /** `any` and `all` are read on the dialog's last line, not on every line. */
  onFooter?: boolean;
  belowLastRule?: RegExp;
  /** The window has no composer rule: the dialog is the pane. */
  withoutRule?: boolean;
  noneAfter?: { anchor: LinePattern; patterns: LinePattern[] };
};

export type Stage = { rules: Rule[] };

export type Placeholder = { equals: string } | { prefix: string };

/** How a composer continues a line onto its next row, from a capture that shows it: the
 *  continuation starts at the text column (the box's own indent), and the break folds the space
 *  away at a word boundary or falls mid-word (hard). */
export type Wrap = { continuation: 'text-column'; kind: 'word' | 'hard' };

export type FallbackRule = { all: LinePattern[]; kind: Screen['kind'] };

// The composer's greyed suggestions are told by their styling, when the CLI renders them dim
// (`placeholder_style: dim` in the profile). A source without styling falls back to the list.
export type PlaceholderStyle = 'dim';

// Every composer carries `frameRows`: the empty rows a capture shows the pane drawing under
// the text, inside the box's frame (the drop before the status line or the closing rule). The
// box read strips up to that many trailing empty rows as the frame; a box with any row beyond
// them is a box the text does not have, and is refused. Zero where no capture shows the pane
// drawing such a row: don't guess.
type Box = {
  mode: 'box-to-rule';
  prompt: RegExp;
  rule: RegExp;
  /**
   * For a scrolled-out box, the non-blank lines under the closing rule must match
   * every pattern, in order, and the counts must be equal.
   */
  footers: RegExp[];
  placeholders: Placeholder[];
  placeholderStyle?: PlaceholderStyle;
  wrap?: Wrap;
  frameRows: number;
};
/** Where a status row must sit, from the composer section. `line` is the line directly under the
 *  row (the workspace line), which must be the pane's last non-empty one; a row matching `except`
 *  is read as it was before this field — by its grammar alone. */
export type StatusBelow = { line: RegExp; except: RegExp | null };

/** The status line's patterns — one, or a list where no single pattern fits the dialect's length
 *  cap. A line is a candidate when it matches any of them. */
export type StatusLine = RegExp[];

/** The box's own border rows, declared only for a CLI whose captures draw them: `top` is the row
 *  directly above the input row, `bottom` the row directly below the input rows and directly
 *  above the status row, both whole rows at one width (the captures draw them at the pane's
 *  width). The bordered frame is read beside the blank one; a frame with only one of the two
 *  rows, a row displaced from the input row or the status row, or a border-shaped row inside
 *  the box is refused. A composer without this field reads only the blank frame. */
export type Border = { top: RegExp; bottom: RegExp };

type StatusLast = { mode: 'status-last'; statusLine: StatusLine; statusBelow?: StatusBelow; prompt: RegExp; placeholders: Placeholder[]; placeholderStyle?: PlaceholderStyle; wrap?: Wrap; frameRows: number; border?: Border };
type StatusThenOne = {
  mode: 'status-then-one';
  statusLine: StatusLine;
  statusBelow?: StatusBelow;
  prompt: RegExp;
  placeholders: Placeholder[];
  placeholderStyle?: PlaceholderStyle;
  stripSuffix: RegExp | null;
  fallback: FallbackRule[];
  wrap?: Wrap;
  frameRows: number;
  border?: Border;
};
type TwoRules = {
  mode: 'two-rules-footer-below';
  prompt: RegExp;
  rule: RegExp;
  /** Any line below the closing rule matches any pattern in the list. */
  footers: RegExp[];
  placeholders: Placeholder[];
  /** A row that stands for hidden rows of a folded paste; capture 1 is the hidden count. */
  fold: RegExp | null;
  placeholderStyle?: PlaceholderStyle;
  wrap?: Wrap;
  frameRows: number;
};

export type Composer = Box | StatusLast | StatusThenOne | TwoRules;

export type ScreenData = {
  chrome: RegExp[];
  unknown?: Stage;
  trust?: Stage;
  permission?: Stage;
  question?: Stage;
  working?: Stage;
  composer: Composer;
  profile?: ScreenProfile;
};
