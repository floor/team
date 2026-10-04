// The shape of a profile's screen, after the dialect has compiled its patterns.
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

export type FallbackRule = { all: LinePattern[]; kind: Screen['kind'] };

// The composer's greyed suggestions are told by their styling, when the CLI renders them dim
// (`placeholder_style: dim` in the profile). A source without styling falls back to the list.
export type PlaceholderStyle = 'dim';

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
};
type StatusLast = { mode: 'status-last'; statusLine: RegExp; prompt: RegExp; placeholders: Placeholder[]; placeholderStyle?: PlaceholderStyle };
type StatusThenOne = {
  mode: 'status-then-one';
  statusLine: RegExp;
  prompt: RegExp;
  placeholders: Placeholder[];
  placeholderStyle?: PlaceholderStyle;
  stripSuffix: RegExp | null;
  fallback: FallbackRule[];
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
};
