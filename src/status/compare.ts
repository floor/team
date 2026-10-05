import type { Seat, TeamFile } from '../file/types.ts';
import type { HerdrAgent, HerdrWorkspace } from '../herdr.ts';
import { herdrCommand } from '../herdr.ts';
import type { SessionState } from '../state.ts';
import { readScreen } from '../watch/screen.ts';
import { seatModel } from './statusline.ts';

// What herdr shows of a session. `screens` holds a pane's visible text, where it could be read.
export type Live = {
  running: boolean;
  agents: HerdrAgent[];
  workspaces: HerdrWorkspace[];
  screens: Record<string, string>;
};

export type Row = { name: string; state: string; model: string; pane: string; start_cwd?: string };

/** The repair of the one precondition `status` knows: the file is not the approved one. The
 *  approval differences carry it, and a repair that waits on it is marked with it. */
export const APPROVAL_REPAIR = 'the owner runs team approve';

/**
 * One disagreement, with the two facts about its repair that the renderer needs and must not
 * re-derive from the repair's wording, both set where the difference is created:
 *
 * - `needs`: the repair names a command that refuses while the file is not the approved one.
 *   Confirmed from the commands themselves: `team up` (`up.ts`), `team add` (`add.ts`), and
 *   `team worktree` (`worktree.ts`) each refuse on the standing before they do anything. Such a
 *   repair waits for `APPROVAL_REPAIR`, and is printed with `(after: …)` while the approval
 *   difference is there. A difference is never marked for a command that does not refuse.
 * - `owner`: the repair is one of the owner's commands (the summary line counts these).
 *
 * `approval` marks the approval difference itself: it is the precondition, printed first.
 */
export type Difference = {
  what: string;
  repair: string;
  needs?: 'approve';
  owner?: true;
  approval?: true;
};

>>>>>>> origin/main
export type Comparison = { rows: Row[]; differences: Difference[]; notes: string[] };

export const WATCH_LABEL = 'watchdog';

/**
 * The approval differences first, then the repairs that wait on one marked `(after: …)`. The
 * order otherwise stays as the differences were created. Nothing here decides what blocks a
 * launch: that is `blocksLaunch` (`src/commands/doctor.ts`), and it is `team doctor`'s to report
 * — a missing watch does not block one, and no repair is marked for it.
 */
export function orderAndAnnotateDifferences(differences: Difference[]): Difference[] {
  const approval = differences.filter((diff) => diff.approval);
  if (approval.length === 0) return differences;
  const rest = differences
    .filter((diff) => !diff.approval)
    .map((diff) => (diff.needs === 'approve' ? { ...diff, repair: `${diff.repair} (after: ${APPROVAL_REPAIR})` } : diff));
  return [...approval, ...rest];
}

// Compares the file and the state with the live session. Pure: every input is handed in.
// `watch` is the watch values in force — the approved ones — so an unapproved edit can't move a verdict.
export function compare(
  team: TeamFile,
  session: string,
  state: SessionState,
  live: Live,
  now: Date = new Date(),
  watch: TeamFile['watch'] = team.watch,
): Comparison {
  const rows: Row[] = [];
  const differences: Difference[] = [];
  const notes: string[] = [];
  const claimed = new Set<string>();
  const labels = new Map(live.workspaces.map((workspace) => [workspace.id, workspace.label]));
  const anyRunning = team.seats.some((seat) => live.agents.some((agent) => agent.name === seat.name));

  for (const seat of team.seats) {
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    const recorded = state.seats[seat.name];
    if (agent) {
      claimed.add(agent.pane);
      const model = modelOf(seat, agent, live, differences, notes);
      const screenText = live.screens[agent.pane];
      const screen = readScreen(seat.cli, screenText);
      // `done` is as free as `idle`: delivery types into either one (`deliver.ts`), and the
      // watch's unsent check covers both (`pass.ts`). The report reads them the same way.
      const quiet = agent.status === 'idle' || agent.status === 'done';
      const isUnsent = quiet && screen.kind === 'unsent';
      const stateText = isUnsent
        ? (seat.parked ? `${agent.status} (unsent text), parked` : `${agent.status} (unsent text)`)
        : (seat.parked ? `${agent.status}, parked` : agent.status);
      rows.push({
        name: seat.name,
        state: stateText,
        model,
        pane: agent.pane,
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      if (seat.stopped) {
        differences.push({
          what: `${seat.name} is marked stopped in the file and is running`,
          repair: `team remove ${seat.name} --keep, or take "stopped: true" off the seat`,
        });
      }
      if (isUnsent && recorded?.stage === 'named') {
        differences.push({
          what: `${seat.name}: its launch stopped at "named", and it holds text in its input box that was never sent`,
          repair: 'the owner clears or sends it in the pane, then runs team up (it resumes the launch)',
          needs: 'approve',
          owner: true,
        });
      } else {
        if (recorded && recorded.stage !== 'ready') {
          differences.push({
            what: `${seat.name}: its launch stopped at "${recorded.stage}"`,
            repair: 'the owner runs team up (it resumes the launch)',
            needs: 'approve',
            owner: true,
          });
        }
        if (isUnsent) {
          differences.push({
            what: `${seat.name} holds text in its input box that was never sent`,
            repair: "the owner clears or sends it in the pane; team does not type into a box it can't verify",
            owner: true,
          });
        }
      }
      if (recorded?.rules === 'undelivered') {
        differences.push({
          what: `${seat.name}: its rules were not delivered`,
          repair: `team remove ${seat.name} --keep, then team add ${seat.name}`,
          needs: 'approve',
        });
      }
      continue;
    }
    if (seat.stopped) {
      rows.push({
        name: seat.name,
        state: 'stopped',
        model: seat.display,
        pane: '-',
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      continue;
    }
    // An agent sits in the workspace recorded for this name, under another name or under none.
    // The display label is not a key: two seats may share it.
    const stray = recorded?.workspace
      ? live.agents.find((candidate) => !claimed.has(candidate.pane) && candidate.workspace === recorded.workspace
        && !team.seats.some((other) => other.name === candidate.name))
      : undefined;
    if (stray) {
      claimed.add(stray.pane);
      rows.push({
        name: seat.name,
        state: 'wrong name',
        model: seat.display,
        pane: stray.pane,
        ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      differences.push({
        what: `${seat.name}: the agent in ${stray.pane} is ${stray.name ? `named "${stray.name}"` : 'unnamed'}`,
        repair: herdrCommand(session, 'agent', 'rename', stray.pane, seat.name),
      });
      continue;
    }
    rows.push({
      name: seat.name,
      state: 'missing',
      model: seat.display,
      pane: '-',
      ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
    });
    differences.push({
      what: `${seat.name} is in the file and is not running`,
      repair: anyRunning ? `team add ${seat.name}` : 'the owner runs team up',
      needs: 'approve',
      ...(anyRunning ? {} : { owner: true as const }),
    });
  }

  for (const [name, recorded] of Object.entries(state.seats)) {
    if (!recorded.temporary) continue;
    const agent = live.agents.find((candidate) => candidate.name === name);
    if (agent) {
      claimed.add(agent.pane);
      rows.push({ name, state: `${agent.status}, temporary`, model: `like ${recorded.temporary.like}`, pane: agent.pane });
      notes.push(`${name} is temporary, until ${recorded.temporary.until}`);
    } else {
      differences.push({ what: `${name}: a temporary seat is recorded and is not running`, repair: `team remove ${name}` });
    }
  }

  for (const agent of live.agents) {
    if (claimed.has(agent.pane) || labels.get(agent.workspace) === WATCH_LABEL) continue;
    differences.push({
      what: `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane}) is running and is not in the file`,
      repair: 'add the seat to the file and run team approve, or close it',
    });
  }

  for (const [task, worktree] of Object.entries(state.worktrees)) {
    if (worktree.setup === 'failed') {
      differences.push({ what: `worktree ${task}: its setup failed`, repair: `team worktree remove ${task}`, needs: 'approve' });
    }
  }

  if (live.running && anyRunning) {
    const beat = state.watch ? Date.parse(state.watch.heartbeat) : NaN;
    if (!state.watch) {
      differences.push({ what: 'no watch has run for this session', repair: `team watch --session ${session}` });
    } else if (!(now.getTime() - beat <= 2 * watch.interval * 1000)) {
      const minutes = Number.isFinite(beat) ? Math.round((now.getTime() - beat) / 60_000) : null;
      differences.push({
        what: `the watch's last pass was ${minutes === null ? 'never recorded' : `${minutes} minute(s) ago`}`,
        repair: `team watch --session ${session}`,
      });
    }
  }

  return { rows, differences, notes };
}

function modelOf(seat: Seat, agent: HerdrAgent, live: Live, differences: Difference[], notes: string[]): string {
  const running = seatModel(seat, live.screens[agent.pane]);
  if (!running) {
    notes.push(`${seat.name}: version unread (its screen doesn't show the model)`);
    return `${seat.display} (unread)`;
  }
  if (running.model === seat.model && running.version === seat.version) return seat.display;
  differences.push({
    what: `${seat.name} runs ${running.model} ${running.version}; the file says ${seat.model} ${seat.version}`,
    repair: `restart the seat on the file's model (team remove ${seat.name} --keep, then team add ${seat.name}), or correct the file and run team approve`,
    needs: 'approve',
  });
  return `${running.model} ${running.version} (file: ${seat.display})`;
}
