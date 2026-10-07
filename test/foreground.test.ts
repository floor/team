import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { foregroundArgv0, shellBackOf } from '../src/herdr.ts';
import { reportedLiveAgent } from '../src/launch/agent.ts';
import { profileFor } from '../src/profiles/index.ts';

const body = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/herdr/${name}`, import.meta.url), 'utf8'));

describe('a live agent is every foreground argv0', () => {
  test('claude is live when caffeinate is listed first and name is a version', () => {
    const parsed = body('claude-with-caffeinate.json');
    const argv0 = foregroundArgv0(parsed);
    const names = parsed.process_info.foreground_processes.map((proc: { name: string }) => proc.name);
    expect(argv0).toEqual(['caffeinate', 'claude']);
    expect(names).toEqual(['caffeinate', '2.1.289']);
    expect(reportedLiveAgent(argv0, profileFor('claude-code')?.processNames ?? [])).toBe(true);
    expect(reportedLiveAgent(names, profileFor('claude-code')?.processNames ?? [])).toBe(false);
  });

  test('a plain claude list is read the same way', () => {
    const parsed = body('claude-plain.json');
    const argv0 = foregroundArgv0(parsed);
    expect(argv0?.[0]).toBe('caffeinate');
    expect(argv0).toContain('claude');
    expect(reportedLiveAgent(argv0, profileFor('claude-code')?.processNames ?? [])).toBe(true);
  });

  test('cursor-agent is argv0, not the name node', () => {
    const parsed = body('cursor-agent.json');
    const argv0 = foregroundArgv0(parsed);
    const names = parsed.process_info.foreground_processes.map((proc: { name: string }) => proc.name);
    expect(argv0).toEqual(['cursor-agent']);
    expect(names).toEqual(['node']);
    expect(reportedLiveAgent(argv0, profileFor('cursor')?.processNames ?? [])).toBe(true);
    expect(reportedLiveAgent(names, profileFor('cursor')?.processNames ?? [])).toBe(false);
  });
});

describe('a pane back at its shell', () => {
  test('the shell process itself is the foreground program', () => {
    expect(shellBackOf(body('shell-back.json'))).toBe(true);
  });

  test('a program in front is not the shell, even when its argv0 is zsh', () => {
    expect(shellBackOf(body('claude-plain.json'))).toBe(false);
    expect(shellBackOf(body('zsh-script.json'))).toBe(false);
  });

  test('the pane the CLI left is back at its shell, captured right after a hand-typed /exit', () => {
    // The capture this file's README names: the pane's own shell is the foreground process
    // again, its pid `shell_pid`, the group the shell's — the reading that calls a seat
    // whose CLI already exited what it is.
    const parsed = body('zsh-after-exit.json');
    expect(parsed.type).toBe('pane_process_info');
    expect(shellBackOf(parsed)).toBe(true);
  });

  test("an herdr that can't say reads null, never a guess", () => {
    expect(shellBackOf(null)).toBeNull();
    expect(shellBackOf({})).toBeNull();
    expect(shellBackOf({ process_info: {} })).toBeNull();
    expect(shellBackOf({ process_info: { foreground_processes: [{ pid: 1 }] } })).toBeNull();
    expect(shellBackOf({ process_info: { shell_pid: 1, foreground_processes: [] } })).toBeNull();
    expect(shellBackOf({ process_info: { shell_pid: 1, foreground_processes: [{ pid: '1' }] } })).toBeNull();
    expect(shellBackOf({ process_info: { shell_pid: '1', foreground_processes: [{ pid: 1 }] } })).toBeNull();
    expect(
      shellBackOf({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 2 }, { pid: null }] } }),
    ).toBeNull();
  });
});
