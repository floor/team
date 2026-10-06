// `typeExit` over real screens: it types the exit text once into an idle box and presses the
// Enter on the second reading only — the box that reads back as exactly the typed text — never
// on the reading taken the instant after the send, which is still the idle screen because the
// pane has not drawn the text yet. Every screen below is a capture from a live pane (plain
// claude, codex and cursor-agent under herdr 0.7.1); test/fixtures/exit-typing/README.md says
// how each was taken and what the box holds.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type ExitIo, typeExit } from '../src/commands/down.ts';
import { boxHoldsOther, boxHoldsText } from '../src/launch/deliver.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readScreen } from '../src/watch/screen.ts';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/exit-typing/${name}`, import.meta.url), 'utf8');
const exitText = (cli: string): string => profileFor(cli)?.exit ?? '';

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

describe("the CLI's own question is not a composer", () => {
  test('both captured exit questions read as a question, and hold no exit text', () => {
    for (const name of ['claude-code-shell-question-ansi.txt', 'claude-code-scheduled-question-ansi.txt']) {
      const screen = fixture(name);
      expect(readScreen('claude-code', screen).kind).toBe('question');
      expect(boxHoldsText('claude-code', '/exit', screen)).toBe(false);
      expect(boxHoldsOther('claude-code', '/exit', screen)).toBe(null);
    }
  });

  test('a pane that draws that question after the typing gets no Enter', async () => {
    const pane = paneOf('claude-code', 'claude', fixture('claude-code-idle-ansi.txt'), fixture('claude-code-shell-question-ansi.txt'));
    expect(await typeExit(pane.io, 'claude-code', exitText('claude-code'))).toBe(false);
    expect(pane.sent).toEqual([]);
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
