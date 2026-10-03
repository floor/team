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
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*[❯›>]/.test(lines[i] as string)) {
        at = i;
        break;
      }
    }
    if (at < 0) return { kind: 'unknown' };
    const typed = (lines[at] as string).replace(/^\s*[❯›>]/, '').trim();
    // The box runs to the rule below it: text on a later line of the box is unsent text too,
    // as after a first line left empty.
    for (let i = at + 1; i < lines.length && !/^\s*[─━]{8,}/.test(lines[i] as string); i++) {
      if ((lines[i] as string).trim()) return { kind: 'unsent' };
    }
    // An empty box shows nothing, or a greyed suggestion that starts with Try ".
    return typed === '' || typed.startsWith('Try "') ? { kind: 'idle' } : { kind: 'unsent' };
  },
};

export function readScreen(cli: string, screen: string | undefined): Screen {
  if (screen === undefined) return { kind: 'unknown' };
  const lines = screen.split('\n').map((line) => line.trimEnd()).slice(-20);
  return CLASSIFIERS[cli]?.(lines) ?? { kind: 'unknown' };
}
