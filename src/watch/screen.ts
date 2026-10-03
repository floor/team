// What a pane's visible text shows, read against the shapes of its CLI. A screen that matches no
// shape is "unknown": never ready, never idle, and never grounds for typing anything.
import { codexScreen } from '../profiles/codex-screen.ts';
import { antigravityScreen } from '../profiles/antigravity-screen.ts';

export type Screen =
  | { kind: 'idle' }                 // the idle prompt, with an empty input box
  | { kind: 'working' }              // a turn is running: herdr's status would already be stale
  | { kind: 'unsent' }               // text left in the input box
  | { kind: 'permission' }           // a permission dialog: its owner's to answer
  | { kind: 'trust' }                // a workspace trust question: left unanswered
  | { kind: 'question' }             // a question the agent asked: the operator's to act on
  | { kind: 'unknown' };

type Classify = (lines: string[]) => Screen;

// The workspace dialog Claude 2.1.288 showed on the live run: the question line
// "Is this a project you created or one you trust?" and a numbered "1. Yes".
// A transcript that only quotes "trust this folder" has neither shape.
function trustDialog(lines: string[]): boolean {
  const question = (line: string) =>
    /Do you trust (?:this|the) folder\?/i.test(line) || /one you trust\?/i.test(line);
  const choice = (line: string) => /^\s*[❯›>]?\s*1\.\s+Yes\b/.test(line);
  return lines.some(question) && lines.some(choice);
}

const CLASSIFIERS: Record<string, Classify> = {
  codex: codexScreen,
  antigravity: antigravityScreen,
  // Claude Code, from the shapes team-watch.sh has matched on the live team.
  'claude-code': (lines) => {
    const text = lines.join('\n');
    // Before the permission shapes: "1. Yes" is how a trust question is answered, and it is not answered.
    if (trustDialog(lines)) return { kind: 'trust' };
    if (/Do you want to (proceed|make this edit|create|allow)|\bEsc to cancel\b.*\bTab to amend\b|^\s*❯?\s*[0-9]\. (Yes|No)\b/m.test(text)) {
      return { kind: 'permission' };
    }
    if (/Enter to select|↑\/↓ to navigate|Enter to confirm|Esc to cancel/.test(text)) return { kind: 'question' };
    // A running turn: its spinner line names the work in progress and its elapsed time, and the
    // input box below it can look empty all the same. A finished turn keeps its "done" stamp.
    if (/\besc to interrupt\b/.test(text) || /^[^\S\n]*[✢✳✶✻✼✽][^\n]*…\s*\(\s*\d/m.test(text)) return { kind: 'working' };
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
