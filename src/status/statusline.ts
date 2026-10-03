// Each CLI shows its model in its own words. A normalisation turns a pane's visible text into the
// file's two fields, `model` and `version`, or null when the text doesn't show them: "unread" is
// never a mismatch.
import { codexModel } from '../profiles/codex.ts';

export type Running = { model: string; version: string };

type Normalise = (screen: string) => Running | null;

const NORMALISERS: Record<string, Normalise> = {
  antigravity: (screen) => {
    let found: Running | null = null;
    for (const line of screen.split('\n').slice(-6)) {
      const match = /(?:^|[\s·|])Gemini\s+([0-9]+(?:\.[0-9]+)*)\s+(Flash|Pro)\b/i.exec(line);
      if (match && match[1] && match[2]) {
        const family = match[2];
        found = {
          model: `Gemini ${family[0]?.toUpperCase()}${family.slice(1).toLowerCase()}`,
          version: match[1],
        };
      }
    }
    return found;
  },
  codex: (screen) => {
    const footer = screen.split('\n').slice(-6).findLast((line) => /^\s+GPT-\d[\w.-]*\s+[^·]*·/.test(line));
    const id = footer?.trim().split(/\s/)[0];
    return id ? codexModel(id) : null;
  },
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

// The model a seat runs, as far as its screen can say. Claude Code names Claude's families only:
// for a seat that runs another maker's model through it, the line says nothing to compare, so
// the seat is unread rather than wrong.
export function seatModel(seat: { cli: string; model: string }, screen: string | undefined): Running | null {
  if (screen === undefined) return null;
  if (seat.cli === 'claude-code' && !seat.model.startsWith('Claude ')) return null;
  return runningModel(seat.cli, screen);
}
