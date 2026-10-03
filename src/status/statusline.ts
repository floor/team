// Each CLI shows its model in its own words. A normalisation turns a pane's visible text into the
// file's two fields, `model` and `version`, or null when the text doesn't show them: "unread" is
// never a mismatch.

export type Running = { model: string; version: string };

type Normalise = (screen: string) => Running | null;

const NORMALISERS: Record<string, Normalise> = {
  // Claude Code's status line names the family and the version: "… · Opus 5.5 · …".
  'claude-code': (screen) => {
    let found: Running | null = null;
    for (const line of screen.split('\n').slice(-6)) {
      const match = /(?:^|[\s·|])(Opus|Sonnet|Haiku|Fable)\s+([0-9]+(?:\.[0-9]+)*)(?=$|[\s·|])/.exec(line);
      if (match) found = { model: `Claude ${match[1]}`, version: match[2] as string };
    }
    return found;
  },
};

export function runningModel(cli: string, screen: string): Running | null {
  return NORMALISERS[cli]?.(screen) ?? null;
}
