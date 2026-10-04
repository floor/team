import { readArgs } from '../args.ts';
import { watchInForce } from '../approve/approval.ts';
import { saveReadings } from '../budgets/readings.ts';
import { runChecks, type CheckOutcome } from '../budgets/run.ts';
import { currentTeam } from '../file/current.ts';
import type { TeamFile } from '../file/types.ts';
import { homedir } from 'node:os';
import { agentStatus, paneRead, pressEnter, typeText } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { emptySession, readState, updateState } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { readMachine } from '../watch/machine.ts';
import type { Machine } from '../watch/machine.ts';
import { notify } from '../watch/notify.ts';
import { newMemory, pass } from '../watch/pass.ts';
import { readScreen } from '../watch/screen.ts';
import { judgeTemporary, judgeWorktree } from '../watch/close.ts';
import { readEnd, type EndView } from '../watch/end.ts';
import type { DownSeat } from '../launch/plan.ts';
import { stopRunning, realSources as removeSources } from './remove.ts';
import { removeWorktree } from './worktree.ts';
import { stateOf } from './down.ts';
import { realSources } from './status.ts';

// What the watch reads and does outside its own process, so tests can stand in for it.
export type WatchSources = {
  live(session: string, team: TeamFile): Live | null;
  machine(root: string): Machine;
  approval(team: TeamFile, root: string): string[] | null;
  // The watch values in force: the approved ones, or the defaults when nothing is approved.
  watchInForce(team: TeamFile, root: string): TeamFile['watch'];
  // What each checked account reads this pass (RFC 0003 § 5). Runs outside the pass, like the
  // machine figures: a command's raw output never leaves this call, and a failure reads unknown.
  readChecks(team: TeamFile, root: string, now: number): CheckOutcome[];
  // The operator's screen, read again just before a nudge is typed.
  screen(pane: string, session: string): string | null;
  // The operator's status, asked again with its screen.
  status(pane: string, session: string): string | null;
  typeText(pane: string, text: string, session: string): boolean;
  pressEnter(pane: string, session: string): boolean;
  notify(text: string): void;
  now(): Date;
  // Waits between passes; false ends the watch.
  wait(seconds: number): Promise<boolean>;
  alive(pid: number): boolean;
  pid: number;
  /** How an end is read. The real watch uses git and the filesystem. */
  readEnd?(root: string, until: string, base: string | null, ownBefore: boolean): EndView;
  /** Stops one free seat. The real watch uses the same steps as `remove`. */
  stopSeat?(session: string, seat: DownSeat): Promise<boolean>;
  /** Removes one merged worktree. The real watch calls `worktree remove`. */
  removeWorktree?(task: string): number;
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
  approval: realSources.approval,
  watchInForce: (team, root) => watchInForce(team, root),
  readChecks: (team, root, now) => runChecks(team, root, now),
  screen: (pane, session) => paneRead(pane, 14, session),
  status: agentStatus,
  typeText,
  pressEnter,
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

export const USAGE = 'Usage: team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]\n';

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
  const told = new Set<string>();
  let outcomes: CheckOutcome[] = [];
  let checksAt: number | null = null;
  let notice: string | undefined;
  let silent = false;
  say(`watching the session "${session}" every ${sources.watchInForce(first.team, first.root).interval}s${args.flags.has('no-nudge') ? ', without nudges' : ''}`, false);
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

      // The values in force, read with the file: until the owner approves an edit to `watch`,
      // the watch keeps running with what was approved, or with the defaults.
      const inForce = sources.watchInForce(team, root);
      const live = sources.live(session, team);
      if (!live) {
        if (!silent) say('herdr doesn\'t answer; the watch keeps trying', true);
        silent = true;
      } else {
        silent = false;
        noteWorked(dir, session, live);
        const state = readState(dir).sessions[session] ?? emptySession();
        const now = sources.now().getTime();
        // The check commands run here, outside the pass, at most every `check_every` (§ 5): the
        // pass reads what they read, and nothing else. Only their state is ever said — a
        // contract failure or a timeout says `unreadable`, never a line of what they printed.
        if (checksAt === null || now - checksAt >= team.budgets.checkEvery * 1000) {
          checksAt = now;
          outcomes = sources.readChecks(team, root, now);
          for (const outcome of outcomes) {
            const key = `check:${outcome.account}`;
            if (outcome.state === 'read') {
              told.delete(key);
              continue;
            }
            if (told.has(key)) continue;
            told.add(key);
            say(outcome.state === 'unreadable'
              ? `${outcome.account}: its check is unreadable`
              : `the check for ${outcome.account} is unapproved; that account reads unknown`, false);
          }
        }
        const result = pass(team, state, live, sources.machine(root), now, memory, sources.approval(team, root), inForce, outcomes);
        for (const report of result.reports) say(report.text, true);
        saveReadings(dir, session, result.readings, now);
        if (result.nudge) {
          if (args.flags.has('no-nudge')) say(`nudge not typed (--no-nudge): ${result.nudge.text}`, false);
          else deliver(result.nudge, team, session, sources, memory, say);
        }
        if (result.fallback) say(result.fallback, true);
        await closeEnded({ team, root, dir, session, live, sources, say, io, told });
      }
      beat();
      if (!(await sources.wait(inForce.interval))) break;
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
  nudge: { pane: string; text: string; pending: string[] }, team: TeamFile, session: string, sources: WatchSources,
  memory: ReturnType<typeof newMemory>, say: (text: string, desktop: boolean) => void,
): void {
  const cli = team.seats.find((seat) => seat.name === team.operator)?.cli ?? '';
  const look = () => readScreen(cli, sources.screen(nudge.pane, session) ?? undefined).kind;
  const status = sources.status(nudge.pane, session);
  const keep = () => {
    // The nudge's text carries no report, so the reports it was raised for go back to pending:
    // the fallback notification and the next passes need them.
    memory.pending.push(...nudge.pending);
    memory.pendingSince ??= sources.now().getTime();
  };
  if ((status !== 'idle' && status !== 'done') || look() !== 'idle' || !sources.typeText(nudge.pane, nudge.text, session)) {
    keep();
    return;
  }
  // The text is in the box. A dialog that opened meanwhile must not get the Enter: the text
  // then stays unsent, which the next passes report, and the nudge is kept.
  const after = look();
  if (after !== 'idle' && after !== 'unsent') {
    say('a nudge was typed and not sent: the operator\'s screen changed before the Enter', true);
    keep();
    return;
  }
  if (sources.pressEnter(nudge.pane, session)) say(`nudged the operator: ${nudge.text}`, false);
  else keep();
}

function noteWorked(dir: string, session: string, live: Live): void {
  const recorded = readState(dir).sessions[session];
  if (!recorded) return;
  const due = live.agents.some((agent) => {
    const seat = agent.name ? recorded.seats[agent.name] : undefined;
    return seat?.temporary && seat.stage === 'ready' && !seat.worked && agent.status === 'working';
  });
  if (!due) return;
  updateState(dir, (file) => {
    const seats = (file.sessions[session] ??= emptySession()).seats;
    for (const agent of live.agents) {
      const seat = agent.name ? seats[agent.name] : undefined;
      if (seat?.temporary && seat.stage === 'ready' && agent.status === 'working') seat.worked = true;
    }
  });
}

function sayOnce(told: Set<string>, key: string, text: string | undefined, say: (text: string, desktop: boolean) => void): void {
  if (!text || told.has(key)) return;
  told.add(key);
  say(text, true);
}

// Closes a temporary seat whose end holds, and removes an on-merge worktree whose branch is merged.
// Anything that is not free, or not proved, is left as it is.
async function closeEnded(input: {
  team: TeamFile;
  root: string;
  dir: string;
  session: string;
  live: Live;
  sources: WatchSources;
  say: (text: string, desktop: boolean) => void;
  io: Io;
  told: Set<string>;
}): Promise<void> {
  const { team, root, dir, session, live, sources, say, io, told } = input;
  const endOf = sources.readEnd ?? readEnd;
  const state = readState(dir).sessions[session] ?? emptySession();
  for (const [name, recorded] of Object.entries(state.seats)) {
    const temporary = recorded.temporary;
    if (!temporary) continue;
    const task = temporary.task;
    const work = task ? state.worktrees[task] : undefined;
    const ownBefore = work ? work.own_commits === true : temporary.own_commits === true;
    const end = endOf(root, temporary.until, team.workspace.base, ownBefore);
    const agent = live.agents.find((item) => item.name === name);
    const cli = team.seats.find((seat) => seat.name === temporary.like)?.cli ?? '';
    const free = agent
      ? stateOf(sources.status(agent.pane, session) ?? agent.status, readScreen(cli, sources.screen(agent.pane, session) ?? undefined)) === 'free'
      : false;
    const decision = judgeTemporary({ worked: recorded.worked === true, free, ownBefore, end });
    if (decision.ownCommits) {
      updateState(dir, (file) => {
        const current = (file.sessions[session] ??= emptySession());
        if (work && task) {
          const tree = current.worktrees[task];
          if (tree) tree.own_commits = true;
        } else {
          const seat = current.seats[name];
          if (seat?.temporary) seat.temporary.own_commits = true;
        }
      });
    }
    sayOnce(told, `end:${name}`, decision.report, say);
    if (!decision.close || !agent) continue;
    const seat: DownSeat = { name, cli, pane: agent.pane, workspace: agent.workspace, state: 'free' };
    const stopped = sources.stopSeat
      ? await sources.stopSeat(session, seat)
      : await stopRunning({
        io, dir, session, seat, abandon: false, sources: removeSources, logCommand: 'watch', caller: 'watch',
      });
    if (stopped) say(`closed ${name}; its end ${temporary.until} holds`, false);
  }

  const again = readState(dir);
  const here = again.sessions[session] ?? emptySession();
  for (const [task, work] of Object.entries(here.worktrees)) {
    const occupied = Object.values(again.sessions).some((recorded) =>
      Object.values(recorded.seats).some((seat) => seat.temporary?.task === task));
    const end = endOf(root, `merged:${work.branch}`, team.workspace.base, work.own_commits === true);
    const decision = judgeWorktree({
      policy: team.workspace.remove, occupied, ownBefore: work.own_commits === true, end,
    });
    if (decision.ownCommits) {
      updateState(dir, (file) => {
        const tree = file.sessions[session]?.worktrees[task];
        if (tree) tree.own_commits = true;
      });
    }
    sayOnce(told, `worktree:${task}`, decision.report, say);
    if (!decision.close) continue;
    const code = sources.removeWorktree
      ? sources.removeWorktree(task)
      : removeWorktree(io, { home: homedir(), now: sources.now }, team, root, dir, session, task, 'watch');
    if (code !== 0) say(`worktree ${task} was not removed`, true);
  }
}

