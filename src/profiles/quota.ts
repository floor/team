// A profile's quota patterns. They are read after a screen is classified, and they
// only produce figures: they never change what the screen is.

export const WINDOWS = ['session', 'daily', 'weekly'] as const;
export type WindowName = (typeof WINDOWS)[number];

export type QuotaPattern = {
  account: string;
  window: WindowName;
  match: RegExp;
  side: 'left' | 'used';
  /** A template such as `{1}%`. */
  figure: string;
  /** A template for a duration such as `114h4m`, or null when the line has none. */
  resets: string | null;
};

export type QuotaFigure = {
  account: string;
  window: WindowName;
  /** 0 to 100. `left` and `used` add to 100. */
  left: number;
  used: number;
  resets: string | null;
};

const RESET = /^(?:[0-9]+h(?:[0-9]+m)?|[0-9]+m)$/;
const PERCENT = /^([0-9]+)%$/;

/**
 * Figures from the profile's status line: the last line of the window that matches `statusLine`,
 * as the composer reads it. A cut line, or a figure over 100, is absent, and with no status line
 * identified there are no figures at all — a pattern must never read the transcript or the input
 * box, where a seat can print or type a line that only looks like a quota.
 */
export function figuresOf(
  patterns: readonly QuotaPattern[],
  screen: string,
  statusLine: RegExp | null,
): QuotaFigure[] {
  if (statusLine === null) return [];
  const lines = screen.split('\n').map((line) => line.trimEnd()).slice(-20);
  let line: string | null = null;
  for (const candidate of lines) if (statusLine.test(candidate)) line = candidate;
  if (line === null) return [];
  const found: QuotaFigure[] = [];
  for (const pattern of patterns) {
    const match = pattern.match.exec(line);
    if (!match) continue;
    const next = figureOf(pattern, match);
    if (next) found.push(next);
  }
  return found;
}

function figureOf(pattern: QuotaPattern, match: RegExpMatchArray): QuotaFigure | null {
  const filled = fill(pattern.figure, match);
  const percent = filled === null ? null : PERCENT.exec(filled);
  const value = percent?.[1] === undefined ? null : Number(percent[1]);
  if (value === null || value > 100) return null;
  let resets: string | null = null;
  if (pattern.resets !== null) {
    resets = fill(pattern.resets, match);
    if (resets === null || !RESET.test(resets)) return null;
  }
  return {
    account: pattern.account,
    window: pattern.window,
    left: pattern.side === 'left' ? value : 100 - value,
    used: pattern.side === 'used' ? value : 100 - value,
    resets,
  };
}

function fill(template: string, match: RegExpMatchArray): string | null {
  let missing = false;
  const out = template.replace(/\{(\d+)\}/g, (_whole, number: string) => {
    const value = match[Number(number)];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : out;
}
