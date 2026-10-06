import { trustPolicy } from '../file/dialogs.ts';
import { declaredModel } from '../file/model.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../herdr.ts';
import { herdrCommand } from '../herdr.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import type { SeatState, SessionState } from '../state.ts';
import { readScreen } from '../watch/screen.ts';
import { modelDiffers, seatModel } from './statusline.ts';

// What herdr shows of a session. `screens` holds a pane's visible text, where it could be read;
// `processes` each seat pane's process identity, where it was read, and null where herdr can't
// tell. A pane the map doesn't hold is not compared: exactly as a seat with no record.
export type Live = {
  running: boolean;
  agents: HerdrAgent[];
  workspaces: HerdrWorkspace[];
  screens: Record<string, string>;
  processes?: Record<string, PaneProcesses | null>;
};

export type Row = { name: string; state: string; model: string; pane: string; stored?: string; start_cwd?: string };

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

export type Comparison = { rows: Row[]; differences: Difference[]; notes: string[] };

export const WATCH_LABEL = 'watchdog';

/** The one row a seat shows while it waits, ahead of the ordinary launch-stopped and unnamed rows. */
function waitingView(
  name: string,
  recorded: SeatState | undefined,
  team: TeamFile,
): { state: string; stored: string; difference: Difference } | null {
  const waiting = recorded?.waiting;
  if (!waiting) return null;
  if (waiting.state === 'trust-sent-recovery') {
    return {
      state: 'trust sent; recovery required',
      stored: 'trust-sent-recovery',
      difference: {
        what: `${name}: trust sent; recovery required`,
        repair: 'the owner runs team up',
        needs: 'approve',
        owner: true,
      },
    };
  }
  const phrase = `waiting for owner (${waiting.classification})`;
  const answer = trustPolicy(team) === 'coordinator' && waiting.classification === 'trust';
  return {
    state: phrase,
    stored: 'waiting-owner',
    difference: {
      what: `${name}: ${phrase}`,
      repair: answer ? `team answer ${name} trust` : 'the owner runs team up',
      needs: 'approve',
      ...(answer ? {} : { owner: true as const }),
    },
  };
}

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
      // The pane is the seat only while the process team launched is still in it. A pane that
      // runs no CLI, or one whose process is not the recorded one, is not this seat: it is
      // never shown idle, working or ready, and never under its model as if it were running.
      const verdict = seatProcessVerdict(recorded?.launched, live.processes?.[agent.pane] ?? null);
      if (verdict === 'gone' || verdict === 'replaced') {
        const { row, difference } = notLaunched(seat, agent.pane, verdict);
        rows.push(row);
        differences.push(difference);
        continue;
      }
      const model = modelOf(seat, agent, live, differences, notes);
      const held = waitingView(seat.name, recorded, team);
      if (held) {
        rows.push({
          name: seat.name,
          state: held.state,
          stored: held.stored,
          model,
          pane: agent.pane,
          ...(recorded?.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
        });
        differences.push(held.difference);
        if (seat.stopped) {
          differences.push({
            what: `${seat.name} is marked stopped in the file and is running`,
            repair: `team remove ${seat.name} --keep, or take "stopped: true" off the seat`,
          });
        }
        continue;
      }
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
    // The pane the state recorded for this seat, with no agent herdr lists under its name: the
    // pane is the seat only while the recorded process is still in it. One left holding its shell,
    // or one whose foreground CLI is not the recorded one, is not this seat — and it is not a
    // stray to rename: the launch ended, and only `up` puts a fresh one there.
    const held = recorded?.pane;
    const verdict = seatProcessVerdict(recorded?.launched, held ? live.processes?.[held] ?? null : null);
    if (held && (verdict === 'gone' || verdict === 'replaced')) {
      claimed.add(held);
      const { row, difference } = notLaunched(seat, held, verdict);
      rows.push(row);
      differences.push(difference);
      continue;
    }
    // A waiting record is read only of a pane that may still hold the seat: one that lost the
    // launched process reads `missing` or `restored, not launched by team` above — never
    // `waiting for owner`, and never under the declared model for a replaced one.
    const waiting = recorded?.pane ? waitingView(seat.name, recorded, team) : null;
    if (waiting && recorded?.pane) {
      rows.push({
        name: seat.name,
        state: waiting.state,
        stored: waiting.stored,
        model: seat.display,
        pane: recorded.pane,
        ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
      differences.push(waiting.difference);
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
      const held = waitingView(name, recorded, team);
      if (held) {
        rows.push({
          name,
          state: held.state,
          stored: held.stored,
          model: `like ${recorded.temporary.like}`,
          pane: agent.pane,
          ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
        });
        differences.push(held.difference);
        notes.push(`${name} is temporary, until ${recorded.temporary.until}`);
        continue;
      }
      rows.push({
        name,
        state: `${agent.status}, temporary`,
        model: `like ${recorded.temporary.like}`,
        pane: agent.pane,
        ...(recorded.start_cwd ? { start_cwd: recorded.start_cwd } : {}),
      });
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

// A pane that no longer holds the process team launched: no CLI at all, or a foreground CLI that
// is not the recorded one. The row and the difference read the same wherever the pane is found —
// a pane herdr still lists an agent in, and one the agent went with its CLI.
function notLaunched(seat: Seat, pane: string, verdict: 'gone' | 'replaced'): { row: Row; difference: Difference } {
  return {
    row: {
      name: seat.name,
      state: verdict === 'gone' ? 'missing' : 'restored, not launched by team',
      // A replaced pane runs a CLI team did not launch: its model is unknown, so it is never
      // shown under the declared one as if it were running. A pane with no CLI holds no model
      // either, but `missing` rows carry the declared one as they always have.
      model: verdict === 'gone' ? seat.display : '-',
      pane,
    },
    difference: {
      what: verdict === 'gone'
        ? `${seat.name}: its pane runs no CLI (the CLI ended or the session was restored)`
        : `${seat.name}: the process in its pane is not the one team launched; nothing checks its model, account or rules`,
      repair: 'the owner runs team up',
      needs: 'approve',
      owner: true,
    },
  };
}

function modelOf(seat: Seat, agent: HerdrAgent, live: Live, differences: Difference[], notes: string[]): string {
  const running = seatModel(seat, live.screens[agent.pane]);
  if (!running) {
    notes.push(`${seat.name}: version unread (its screen doesn't show the model)`);
    return `${seat.display} (unread)`;
  }
  if (!modelDiffers(running, seat)) return seat.display;
  differences.push({
    what: `${seat.name} runs ${running.model} ${running.version}; the file says ${declaredModel(seat)}`,
    repair: `restart the seat on the file's model (team remove ${seat.name} --keep, then team add ${seat.name}), or correct the file and run team approve`,
    needs: 'approve',
  });
  return `${running.model} ${running.version} (file: ${seat.display})`;
}
