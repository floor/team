import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { exitQuestionSelected, typeExit, type ExitIo } from '../../src/commands/down.ts';
import { boxHoldsText } from '../../src/launch/deliver.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { readScreen } from '../../src/watch/screen.ts';

function capture(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
}

const EXIT = '/exit';

/** The idle placeholder right after typing, then the box holding exactly the exit text. */
const DRAWN = [
  ['claude-code', 'claude-code/2.1.291/exit-idle.txt', 'claude-code/2.1.291/exit-menu.txt'],
  ['codex', 'codex/0.160.0/exit-idle.txt', 'codex/0.160.0/exit-menu.txt'],
  ['cursor', 'cursor/2026.10.01/exit-idle.txt', 'cursor/2026.10.01/exit-menu.txt'],
] as const;

function run(cli: string, screens: readonly string[], liveAfter = screens.length): Promise<{ entered: number; result: Awaited<ReturnType<typeof typeExit>> }> {
  const names = profileFor(cli)?.processNames ?? [];
  let phase = 0;
  let entered = 0;
  let clock = 0;
  const io: ExitIo = {
    typeText() {
      return true;
    },
    sendKey() {
      return true;
    },
    pressEnter() {
      entered += 1;
      phase += 1;
      return true;
    },
    screen: () => screens[Math.min(phase, screens.length - 1)],
    status: () => 'idle',
    foreground: () => (phase >= liveAfter ? ['zsh'] : [...names]),
    sleep: async (ms) => {
      clock += ms;
      // The text is drawn on the first wait, as the captures were a moment after the typing.
      if (phase === 0) phase = 1;
    },
    now: () => clock,
  };
  return typeExit(io, cli, EXIT).then((result) => ({ entered, result }));
}

describe('typeExit reads the captured exit screens', () => {
  test.each(DRAWN)('%s: Enter is pressed once the box holds the exit text, and not on the idle reading', async (cli, idlePath, menuPath) => {
    const idle = capture(idlePath);
    const menu = capture(menuPath);
    expect(readScreen(cli, idle).kind).toBe('idle');
    expect(boxHoldsText(cli, EXIT, idle)).toBe(false);
    expect(readScreen(cli, menu).kind).toBe('unsent');
    expect(boxHoldsText(cli, EXIT, menu)).toBe(true);
    const { entered, result } = await run(cli, [idle, menu]);
    expect(result).toBe(true);
    expect(entered).toBe(1);
  });

  test.each(DRAWN)('%s: a box that is not exactly the exit text gets no Enter', async (cli, idlePath, menuPath) => {
    const idle = capture(idlePath);
    const other = capture(menuPath).replaceAll(EXIT, '/quit');
    expect(boxHoldsText(cli, EXIT, other)).toBe(false);
    const { entered, result } = await run(cli, [idle, other]);
    expect(entered).toBe(0);
    expect(result).toEqual(expect.objectContaining({ left: expect.stringContaining('nothing more was sent') }));
  });

  test('a Claude Code seat with a background shell is asked the same way, then its exit question is confirmed', async () => {
    const cli = 'claude-code';
    const idle = capture('claude-code/2.1.291/exit-shell-idle.txt');
    const menu = capture('claude-code/2.1.291/exit-shell-menu.txt');
    const question = capture('claude-code/2.1.291/exit-question.txt');
    expect(idle).toContain('1 shell');
    expect(readScreen(cli, idle).kind).toBe('idle');
    expect(boxHoldsText(cli, EXIT, idle)).toBe(false);
    expect(boxHoldsText(cli, EXIT, menu)).toBe(true);
    expect(exitQuestionSelected(question)).toBe(true);
    // phase 0 idle, sleep draws the menu (phase 1), first Enter shows the question (phase 2),
    // second Enter is the selected "Exit and stop tasks" and the CLI leaves.
    const names = profileFor(cli)?.processNames ?? [];
    let phase = 0;
    let entered = 0;
    let clock = 0;
    const io: ExitIo = {
      typeText: () => true,
      sendKey: () => true,
      pressEnter() {
        entered += 1;
        phase += 1;
        return true;
      },
      screen: () => [idle, menu, question][Math.min(phase, 2)] ?? question,
      status: () => (phase === 2 ? 'blocked' : 'idle'),
      foreground: () => (entered >= 2 ? ['zsh'] : [...names]),
      sleep: async (ms) => {
        clock += ms;
        if (phase === 0) phase = 1;
      },
      now: () => clock,
    };
    const result = await typeExit(io, cli, EXIT);
    expect(result).toBe(true);
    expect(entered).toBe(2);
  });

  test('an exit question whose selected row is not the exit gets no second Enter', async () => {
    const cli = 'claude-code';
    const idle = capture('claude-code/2.1.291/exit-shell-idle.txt');
    const menu = capture('claude-code/2.1.291/exit-shell-menu.txt');
    const question = capture('claude-code/2.1.291/exit-question.txt').replace('❯ 1. Exit and stop tasks', '  1. Exit and stop tasks').replace('2. Move to background and exit', '❯ 2. Move to background and exit');
    expect(exitQuestionSelected(question)).toBe(false);
    const names = profileFor(cli)?.processNames ?? [];
    let phase = 0;
    let entered = 0;
    let clock = 0;
    const io: ExitIo = {
      typeText: () => true,
      sendKey: () => true,
      pressEnter() {
        entered += 1;
        phase = 2;
        return true;
      },
      screen: () => (phase === 0 ? idle : phase === 1 ? menu : question),
      status: () => 'idle',
      foreground: () => [...names],
      sleep: async (ms) => {
        clock += ms;
        if (phase === 0) phase = 1;
      },
      now: () => clock,
    };
    const result = await typeExit(io, cli, EXIT);
    expect(entered).toBe(1);
    expect(result).toEqual({ left: 'its exit was not confirmed; the exit question had another choice selected; left running' });
  });

  test('an exit question that stays selected after its confirming Enter is left running', async () => {
    const cli = 'claude-code';
    const idle = capture('claude-code/2.1.291/exit-shell-idle.txt');
    const menu = capture('claude-code/2.1.291/exit-shell-menu.txt');
    const question = capture('claude-code/2.1.291/exit-question.txt');
    const names = profileFor(cli)?.processNames ?? [];
    let phase = 0;
    let entered = 0;
    let clock = 0;
    const io: ExitIo = {
      typeText: () => true,
      sendKey: () => true,
      pressEnter() {
        entered += 1;
        phase += 1;
        return true;
      },
      screen: () => [idle, menu, question][Math.min(phase, 2)] ?? question,
      status: () => (phase >= 2 ? 'blocked' : 'idle'),
      foreground: () => [...names],
      sleep: async (ms) => {
        clock += ms;
        if (phase === 0) phase = 1;
      },
      now: () => clock,
    };
    const result = await typeExit(io, cli, EXIT);
    expect(entered).toBe(2);
    expect(result).toEqual({ left: 'its exit was not confirmed; the exit question stayed open; left running' });
  });

  test('once the exit question is gone, the typing is done and the later wait confirms the process left', async () => {
    const cli = 'claude-code';
    const idle = capture('claude-code/2.1.291/exit-shell-idle.txt');
    const menu = capture('claude-code/2.1.291/exit-shell-menu.txt');
    const question = capture('claude-code/2.1.291/exit-question.txt');
    const after = capture('claude-code/2.1.291/exit-after-enter.txt');
    const names = profileFor(cli)?.processNames ?? [];
    let phase = 0;
    let entered = 0;
    let clock = 0;
    const io: ExitIo = {
      typeText: () => true,
      sendKey: () => true,
      pressEnter() {
        entered += 1;
        phase += 1;
        return true;
      },
      screen: () => [idle, menu, question, after][Math.min(phase, 3)] ?? after,
      status: () => 'idle',
      foreground: () => [...names],
      sleep: async (ms) => {
        clock += ms;
        if (phase === 0) phase = 1;
      },
      now: () => clock,
    };
    const result = await typeExit(io, cli, EXIT);
    expect(entered).toBe(2);
    expect(result).toBe(true);
    expect(clock).toBeLessThan(5000);
  });

  test('Enter on the slash menu with no background shell leaves the shell, and the menu does not stay', async () => {
    const after = capture('claude-code/2.1.291/exit-after-enter.txt');
    expect(after).toContain('❯');
    expect(exitQuestionSelected(after)).toBe(false);
    expect(readScreen('claude-code', after).kind).not.toBe('unsent');
  });
});
