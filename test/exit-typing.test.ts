// `typeExit` over real screens: it types the exit text once into an idle box and presses the
// Enter on the second reading only — the box that reads back as exactly the typed text — never
// on the reading taken the instant after the send, which is still the idle screen because the
// pane has not drawn the text yet. The screens below are captures from a live pane (plain
// claude, codex and cursor-agent under herdr 0.7.1), except three constructed boundary screens
// named as constructed in test/fixtures/exit-typing/README.md, which says how each file was
// taken, built and what the box holds.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type ExitIo, typeExit } from '../src/commands/down.ts';
import { boxHoldsOther, boxHoldsText } from '../src/launch/deliver.ts';
import { exitConfirmKey, profileFor } from '../src/profiles/profile.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { readScreen, screenData } from '../src/watch/screen.ts';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/exit-typing/${name}`, import.meta.url), 'utf8');
const exitText = (cli: string): string => profileFor(cli)?.exit ?? '';

/** An ordinary question of the same CLI — the agent's own, out of the fixtures the reader
 *  already reads — so the exit question's kind can be shown not to swallow it. */
const ordinaryQuestion = readFileSync(new URL('./fixtures/claude-code/2.1.289/question-ansi.txt', import.meta.url), 'utf8');

/** The three CLIs' captured pairs: the reading the instant after `/exit` is sent, and the
 *  reading about two seconds later with the box holding exactly the text. */
const CAPTURED = [
  { cli: 'claude-code', binary: 'claude', idle: 'claude-code-idle-ansi.txt', unsent: 'claude-code-unsent-ansi.txt' },
  { cli: 'codex', binary: 'codex', idle: 'codex-idle-ansi.txt', unsent: 'codex-unsent-ansi.txt' },
  { cli: 'cursor', binary: 'cursor-agent', idle: 'cursor-idle-ansi.txt', unsent: 'cursor-unsent-ansi.txt' },
] as const;

/** A Claude Code seat holding background work: the same pair, with the CLI's own `1 shell still
 *  running` (or a scheduled task) over the box. */
const BACKGROUND = [
  { idle: 'claude-code-shell-idle-ansi.txt', unsent: 'claude-code-shell-unsent-ansi.txt' },
  { idle: 'claude-code-scheduled-idle-ansi.txt', unsent: 'claude-code-scheduled-unsent-ansi.txt' },
] as const;

/** A key that was sent, with the reading that was on the screen at the moment it went out. */
type Sent = { key: string; kind: string; holds: boolean };

/** One pane whose screen follows its two captures: `before` until the exit text has been typed
 *  and the pane has drawn it — herdr's `send-text` returns before the pane renders, so the
 *  drawing is the sleep — and `after` from then on. `status()` is herdr's own reading and stays
 *  resting; `foreground()` is what `pane process-info` answers for a seat launched by name
 *  (`"argv0":"claude"`), which is the caller check every key waits for. */
function paneOf(cli: string, binary: string, before: string, after: string): { io: ExitIo; sent: Sent[] } {
  const text = exitText(cli);
  let typed = false;
  let drawn = false;
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const screen = () => (typed && drawn ? after : before);
  const send = (key: string): boolean => {
    sent.push({ key, kind: readScreen(cli, screen()).kind, holds: boxHoldsText(cli, text, screen()) });
    return true;
  };
  const io: ExitIo = {
    typeText: () => {
      typed = true;
      return true;
    },
    sendKey: send,
    pressEnter: () => send('enter'),
    screen,
    status: () => 'idle',
    foreground: () => [binary],
    sleep: async (ms) => {
      drawn = true;
      clock += ms;
    },
    now: () => clock,
  };
  return { io, sent };
}

/** One pane whose box already holds exactly the exit text when the run starts — the leftover of
 *  an earlier attempt: `leftover` until the profile's clearing key has gone out, then `idle`
 *  until the text is typed and drawn, then `leftover` again. */
function leftoverPane(cli: string, binary: string, leftover: string, idle: string): { io: ExitIo; sent: Sent[] } {
  const text = exitText(cli);
  const key = profileFor(cli)?.exitClear ?? '';
  let cleared = false;
  let typed = false;
  let drawn = false;
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const screen = () => {
    if (!cleared) return leftover;
    return typed && drawn ? leftover : idle;
  };
  const send = (keySent: string): boolean => {
    sent.push({ key: keySent, kind: readScreen(cli, screen()).kind, holds: boxHoldsText(cli, text, screen()) });
    if (keySent === key) cleared = true;
    return true;
  };
  const io: ExitIo = {
    typeText: () => {
      typed = true;
      return true;
    },
    sendKey: send,
    pressEnter: () => send('enter'),
    screen,
    status: () => 'idle',
    foreground: () => [binary],
    sleep: async (ms) => {
      drawn = true;
      clock += ms;
    },
    now: () => clock,
  };
  return { io, sent };
}

describe('the captured pairs', () => {
  test('the first reading is the idle screen and the second holds exactly the exit text', () => {
    for (const { cli, idle, unsent } of CAPTURED) {
      const text = exitText(cli);
      expect(readScreen(cli, fixture(idle)).kind).toBe('idle');
      expect(boxHoldsText(cli, text, fixture(idle))).toBe(false);
      expect(readScreen(cli, fixture(unsent)).kind).toBe('unsent');
      expect(boxHoldsText(cli, text, fixture(unsent))).toBe(true);
    }
  });

  for (const { cli, binary, idle, unsent } of CAPTURED) {
    test(`${cli}: the Enter goes out at the second reading and nowhere else`, async () => {
      const pane = paneOf(cli, binary, fixture(idle), fixture(unsent));
      expect(await typeExit(pane.io, cli, exitText(cli))).toBe(true);
      expect(pane.sent).toEqual([{ key: 'enter', kind: 'unsent', holds: true }]);
    });
  }

  for (const { idle, unsent } of BACKGROUND) {
    test(`claude-code with background work: ${unsent} still gets the Enter at its own reading`, async () => {
      const pane = paneOf('claude-code', 'claude', fixture(idle), fixture(unsent));
      expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(true);
      expect(pane.sent).toEqual([{ key: 'enter', kind: 'unsent', holds: true }]);
    });
  }
});

describe('never a key on anything but the exact read-back', () => {
  test('a box holding more than the exit text is reported, not sent into', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-other-text-ansi.txt'));
    expect(readScreen('claude-code', fixture('claude-code-other-text-ansi.txt')).kind).toBe('unsent');
    expect(boxHoldsOther('claude-code', '/exit', fixture('claude-code-other-text-ansi.txt'))).toBe('/exit now');
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its exit was not confirmed; its box holds text that is not only the exit text (first row that differs: /exit now); nothing more was sent; left running',
    });
    expect(pane.sent).toEqual([]);
  });

  test('a pane that never draws the text is left running with the line that says so', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-idle-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its exit was not confirmed; the pane never drew the typed text; its box is empty; left running',
    });
    expect(pane.sent).toEqual([]);
  });
});

describe("the CLI's own exit question", () => {
  test('both captured exit questions read as their own kind, and hold no exit text', () => {
    for (const name of ['claude-code-shell-question-ansi.txt', 'claude-code-scheduled-question-ansi.txt']) {
      const screen = fixture(name);
      expect(readScreen('claude-code', screen).kind).toBe('exit question');
      expect(boxHoldsText('claude-code', '/exit', screen)).toBe(false);
      expect(boxHoldsOther('claude-code', '/exit', screen)).toBe(null);
    }
  });

  test('ordinary text that quotes the choice row gets the one Enter on the exit text and no second key', async () => {
    const quote = fixture('claude-code-exit-lines-quoted-question.txt');
    expect(readScreen('claude-code', quote).kind).toBe('question');
    expect(quote).toContain('❯ 1. Exit and stop tasks');
    const idle = fixture('claude-code-idle-ansi.txt');
    const unsent = fixture('claude-code-unsent-ansi.txt');
    let phase = 0;
    let clock = 1_000_000;
    const sent: string[] = [];
    const io: ExitIo = {
      typeText: () => {
        phase = 1;
        return true;
      },
      sendKey: (key) => {
        sent.push(key);
        return true;
      },
      pressEnter: () => {
        sent.push('enter');
        phase = 2;
        return true;
      },
      screen: () => (phase === 0 ? idle : phase === 1 ? unsent : quote),
      status: () => 'idle',
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    expect(await typeExit(io, 'claude-code', '/exit')).toBe(true);
    expect(sent).toEqual(['enter']);
  });

  test('the profile key is sent once when the screen reads as the exit question, and a question that stays is reported', async () => {
    const question = fixture('claude-code-shell-question-ansi.txt');
    expect(readScreen('claude-code', question).kind).toBe('exit question');
    const idle = fixture('claude-code-idle-ansi.txt');
    const unsent = fixture('claude-code-unsent-ansi.txt');
    let phase = 0;
    let clock = 1_000_000;
    const sent: string[] = [];
    const io: ExitIo = {
      typeText: () => {
        phase = 1;
        return true;
      },
      sendKey: (key) => {
        sent.push(key);
        return true;
      },
      pressEnter: () => {
        sent.push('enter');
        phase = 2;
        return true;
      },
      screen: () => (phase === 0 ? idle : phase === 1 ? unsent : question),
      status: () => 'idle',
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    const result = await typeExit(io, 'claude-code', '/exit');
    expect(sent).toEqual(['enter', 'enter']);
    expect(result).toEqual({ left: 'its exit was not confirmed; the exit question stayed open; left running' });
  });

  test('a pane that draws that question after the typing gets no Enter', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-shell-question-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(false);
    expect(pane.sent).toEqual([]);
  });
});

describe('the kind is kept apart from the ordinary question', () => {
  test('a question the agent asked still reads as the ordinary question', () => {
    expect(readScreen('claude-code', ordinaryQuestion).kind).toBe('question');
  });

  test('the exit question\'s lines quoted above an ordinary one are prose: it stays ordinary', () => {
    // Built from question-plain.txt with the two lines quoted in the transcript above the box,
    // which carries the common confirmation footer. The three phrases match transcript-wide;
    // only the dialog's own frame may read them, or a stop's Enter would go to this question.
    expect(readScreen('claude-code', fixture('claude-code-exit-lines-quoted-question.txt')).kind).toBe('question');
  });

  test('the quoted lines above a question whose own rule has scrolled out are prose as well', () => {
    // The boundary the first fix still let through: a quote is not enough to tell the kind,
    // because the ordinary question this reader supports with no rule drawn (the shape
    // test/screen-core.test.ts pins) has the shared footer too. Here the quote carries the
    // dialog's two lines and that footer, and the live question follows below; nothing under
    // the quoted choice row but the quote, so the block is not the live dialog and the
    // reading is the ordinary question — before `only_after`, the three phrases matched
    // anywhere and this read `exit question`, and a stop's Enter would have gone into it.
    expect(readScreen('claude-code', fixture('claude-code-exit-lines-quoted-no-rule-question.txt')).kind).toBe('question');
  });

  test('the real exit question below a transcript that quotes it still reads as its own kind', () => {
    // The capture's own dialog, its last 17 lines kept, under a three-line transcript quoting
    // the same two lines: the rule binds the bottom dialog, not the quote.
    expect(readScreen('claude-code', fixture('claude-code-exit-question-below-quote.txt')).kind).toBe('exit question');
  });

  test('the stage is the profile\'s, and beside it the one key that confirms that screen', () => {
    expect(screenData('claude-code')?.exit_question).toBeDefined();
    expect(profileFor('claude-code')?.exitConfirm).toBe('enter');
    // No run established a question for the other three, so none declares a key: a seat that
    // asked one would be one this program cannot stop by asking.
    for (const cli of ['codex', 'cursor', 'antigravity']) expect(profileFor(cli)?.exitConfirm).toBe(null);
  });

  test('the loader takes `enter` and nothing else as `exit_confirm`', () => {
    expect(exitConfirmKey('exit: /exit\nexit_confirm: enter')).toBe('enter');
    expect(exitConfirmKey('exit: /exit')).toBe(null);
    for (const key of ['escape', 'ctrl+c', 'y']) {
      expect(() => exitConfirmKey(`exit: /exit\nexit_confirm: ${key}`)).toThrow('"exit_confirm" must be one of: enter');
    }
  });

  test('a composer fallback cannot claim the kind', () => {
    const snippet = `
format: 1
cli: sample
screen:
  composer:
    mode: status-then-one
    status_line: '^STATUS$'
    prompt: '^>'
    placeholders:
      - equals: ''
    fallback:
      - all: ['^done$']
        kind: exit question
`;
    expect(() => loadScreen(snippet)).toThrow('"kind" cannot be the exit question: it is read from its stage and answered by a stop alone');
  });
});

describe('a box that already holds exactly the exit text', () => {
  test('is cleared with the profile key and then typed fresh', async () => {
    const pane = leftoverPane('claude-code', 'claude', fixture('claude-code-unsent-ansi.txt'), fixture('claude-code-idle-ansi.txt'));
    expect(profileFor('claude-code')?.exitClear).toBe('ctrl+c');
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(true);
    expect(pane.sent).toEqual([
      { key: 'ctrl+c', kind: 'unsent', holds: true },
      { key: 'enter', kind: 'unsent', holds: true },
    ]);
  });

  test('a clearing key that leaves the screen reading unsent stops there', async () => {
    const pane = leftoverPane('claude-code', 'claude', fixture('claude-code-unsent-ansi.txt'), fixture('claude-code-unsent-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toEqual({
      left: 'its box already held this exit text; the clearing key (ctrl+c) left the screen reading unsent; left running',
    });
    expect(pane.sent).toEqual([{ key: 'ctrl+c', kind: 'unsent', holds: true }]);
  });
});
