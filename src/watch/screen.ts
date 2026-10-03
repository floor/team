// What a pane's visible text shows, read against the shapes of its CLI. A screen that matches no
// shape is "unknown": never ready, never idle, and never grounds for typing anything.

export type Screen =
  | { kind: 'idle' }                 // the idle prompt, with an empty input box
  | { kind: 'unsent' }               // text left in the input box
  | { kind: 'permission' }           // a permission or trust dialog: its owner's to answer
  | { kind: 'question' }             // a question the agent asked: the operator's to act on
  | { kind: 'unknown' };

type Classify = (lines: string[]) => Screen;

const CLASSIFIERS: Record<string, Classify> = {
  // Claude Code, from the shapes team-watch.sh has matched on the live team.
  'claude-code': (lines) => {
    const text = lines.join('\n');
    if (/Do you want to (proceed|make this edit|create|allow)|trust this folder|\bEsc to cancel\b.*\bTab to amend\b|^\s*❯?\s*[0-9]\. (Yes|No)\b/m.test(text)) {
      return { kind: 'permission' };
    }
    if (/Enter to select|↑\/↓ to navigate|Enter to confirm|Esc to cancel/.test(text)) return { kind: 'question' };
    // The input line is the last line that starts with the prompt mark.
    const input = [...lines].reverse().find((line) => /^\s*[❯›>]/.test(line));
    if (input === undefined) return { kind: 'unknown' };
    const typed = input.replace(/^\s*[❯›>]/, '').trim();
    // An empty box shows nothing, or a greyed suggestion that starts with Try ".
    return typed === '' || typed.startsWith('Try "') ? { kind: 'idle' } : { kind: 'unsent' };
  },
};

export function readScreen(cli: string, screen: string | undefined): Screen {
  if (screen === undefined) return { kind: 'unknown' };
  const lines = screen.split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-14);
  return CLASSIFIERS[cli]?.(lines) ?? { kind: 'unknown' };
}
