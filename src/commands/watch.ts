import { readArgs } from '../args.ts';
import { currentTeam } from '../file/current.ts';
import type { TeamFile } from '../file/types.ts';
import { paneRead, typeLine } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { emptySession, readState, updateState } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { readMachine } from '../watch/machine.ts';
import type { Machine } from '../watch/machine.ts';
import { notify } from '../watch/notify.ts';
import { newMemory, pass } from '../watch/pass.ts';
import { readScreen } from '../watch/screen.ts';
import { realSources } from './status.ts';

// What the watch reads and does outside its own process, so tests can stand in for it.
export type WatchSources = {
  live(session: string, team: TeamFile): Live | null;
  machine(root: string): Machine;
  // The operator's screen, read again just before a nudge is typed.
  screen(pane: string, session: string): string | null;
  type(pane: string, text: string, session: string): boolean;
  notify(text: string): void;
  now(): Date;
  // Waits between passes; false ends the watch.
  wait(seconds: number): Promise<boolean>;
  alive(pid: number): boolean;
  pid: number;
};

function waitOrStop(seconds: number): Promise<boolean> {
  return new Promise((done) => {
    const stop = () => {
      clearTimeout(timer);
      done(false);
    };
    const timer = setTimeout(() => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done(true);
    }, seconds * 1000);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export const realWatchSources: WatchSources = {
  live: realSources.live,
  machine: readMachine,
  screen: (pane, session) => paneRead(pane, 14, session),
  type: typeLine,
  notify,
  now: () => new Date(),
  wait: waitOrStop,
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  pid: process.pid,
};

export const watch: Command = (argv, io) => runWatch(argv, io, realWatchSources);
export default watch;

const USAGE = 'Usage: team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]\n';

export async function runWatch(argv: string[], io: Io, sources: WatchSources): Promise<number> {
  const args = readArgs(argv, ['session', 'file'], ['no-nudge', 'no-notify']);
  if (args.error || args.rest.length) {
    io.stderr(`team watch: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    return 2;
  }
  const first = currentTeam(io.cwd, args.values.file, sources.now());
  if (!first.ok) {
    for (const problem of first.errors) io.stderr(`team watch: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
    return 2;
  }
  const session = args.values.session ?? first.team.session;
  const { dir } = first;

  const other = readState(dir).sessions[session]?.watch;
  if (other && other.pid !== sources.pid && sources.alive(other.pid)) {
    io.stderr(`team watch: a watch already runs for the session "${session}" (pid ${other.pid})\n`);
    return 1;
  }

  const say = (text: string, desktop: boolean) => {
    io.stdout(`${sources.now().toISOString()} ${text}\n`);
    logLine(dir, 'watch', 'watch', text, sources.now());
    if (desktop && !args.flags.has('no-notify')) sources.notify(text);
  };
  const beat = () => updateState(dir, (state) => {
    const record = (state.sessions[session] ??= emptySession());
    record.watch = { pid: sources.pid, heartbeat: sources.now().toISOString() };
  });

  const memory = newMemory();
  let notice: string | undefined;
  let silent = false;
  say(`watching the session "${session}" every ${first.team.watch.interval}s${args.flags.has('no-nudge') ? ', without nudges' : ''}`, false);
  try {
    for (;;) {
      // The file is read again on every pass, so a seat parked or stopped since is seen.
      const current = currentTeam(io.cwd, args.values.file, sources.now());
      const team = current.ok ? current.team : first.team;
      const root = current.ok ? current.root : first.root;
      const problem = current.ok ? current.notice : `team.yaml can't be read (${current.errors[0]?.message ?? 'unknown'}); watching with the team as it was`;
      if (problem !== notice) {
        notice = problem;
        if (problem) say(problem, true);
      }

      const live = sources.live(session, team);
      if (!live) {
        if (!silent) say('herdr doesn\'t answer; the watch keeps trying', true);
        silent = true;
      } else {
        silent = false;
        const state = readState(dir).sessions[session] ?? emptySession();
        const result = pass(team, state, live, sources.machine(root), sources.now().getTime(), memory);
        for (const report of result.reports) say(report.text, true);
        if (result.nudge) {
          if (args.flags.has('no-nudge')) say(`nudge not typed (--no-nudge): ${result.nudge.text}`, false);
          else deliver(result.nudge, team, session, sources, memory, say);
        }
        if (result.fallback) say(result.fallback, true);
      }
      beat();
      if (!(await sources.wait(team.watch.interval))) break;
    }
  } finally {
    updateState(dir, (state) => {
      const record = state.sessions[session];
      if (record?.watch?.pid === sources.pid) delete record.watch;
    });
    say(`the watch of "${session}" stopped`, true);
  }
  return 0;
}

// Types the nudge, after reading the operator's screen once more: the pass saw it free, and a
// prompt may have appeared since. Anything but an empty idle prompt keeps the nudge pending.
function deliver(
  nudge: { pane: string; text: string }, team: TeamFile, session: string, sources: WatchSources,
  memory: ReturnType<typeof newMemory>, say: (text: string, desktop: boolean) => void,
): void {
  const cli = team.seats.find((seat) => seat.name === team.operator)?.cli ?? '';
  const screen = sources.screen(nudge.pane, session);
  const free = readScreen(cli, screen ?? undefined).kind === 'idle';
  if (free && sources.type(nudge.pane, nudge.text, session)) {
    say(`nudged the operator: ${nudge.text}`, false);
    return;
  }
  memory.pending.push(nudge.text.replace(/^Team watch: /, '').replace(/\.$/, ''));
  memory.pendingSince ??= sources.now().getTime();
}
