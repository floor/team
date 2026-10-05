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

export type Row = { name: string; state: string; model: string; pane: string };
export type Difference = { what: string; repair: string };
export type Comparison = { rows: Row[]; differences: Difference[]; notes: string[] };

export const WATCH_LABEL = 'watchdog';

export function isOwnerRepair(repair: string): boolean {
  return repair.startsWith('the owner');
}

function blocksOnApprove(repair: string): boolean {
  return repair.startsWith('team add ')
    || repair.startsWith('the owner runs team up')
    || (repair.startsWith('team remove ') && repair.includes(', then team add '))
    || repair.startsWith('the owner clears or sends it in the pane, then runs team up');
}

function blocksOnWatch(repair: string): boolean {
  return repair.startsWith('team add ')
    || (repair.startsWith('team remove ') && repair.includes(', then team add '));
}

export function orderAndAnnotateDifferences(differences: Difference[]): Difference[] {
  const approveDiffs: Difference[] = [];
  const watchDiffs: Difference[] = [];
  const otherDiffs: Difference[] = [];

  for (const diff of differences) {
    const baseRepair = diff.repair.replace(/\s+\(after: .*\)$/, '');
    if (baseRepair === 'the owner runs team approve') {
      approveDiffs.push({ ...diff, repair: baseRepair });
    } else if (baseRepair.startsWith('team watch --session ')) {
      watchDiffs.push({ ...diff, repair: baseRepair });
    } else {
      otherDiffs.push({ ...diff, repair: baseRepair });
    }
  }

  const hasApprove = approveDiffs.length > 0;
  const watchRepair = watchDiffs[0]?.repair;
  const hasWatch = Boolean(watchRepair);

  const annotatedOthers = otherDiffs.map((diff) => {
    const repair = diff.repair;
    const blockers: string[] = [];
    if (hasApprove && blocksOnApprove(repair)) {
      blockers.push('the owner runs team approve');
    }
    if (hasWatch && blocksOnWatch(repair)) {
      blockers.push(watchRepair as string);
    }
    if (blockers.length === 0) return diff;
    return { ...diff, repair: `${repair} (after: ${blockers.join(', ')})` };
  });

  return [...approveDiffs, ...watchDiffs, ...annotatedOthers];
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
      const isUnsent = agent.status === 'idle' && screen.kind === 'unsent';
      const stateText = isUnsent
        ? (seat.parked ? 'idle (unsent text), parked' : 'idle (unsent text)')
        : (seat.parked ? `${agent.status}, parked` : agent.status);
      rows.push({ name: seat.name, state: stateText, model, pane: agent.pane });
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
        });
      } else {
        if (recorded && recorded.stage !== 'ready') {
          differences.push({ what: `${seat.name}: its launch stopped at "${recorded.stage}"`, repair: 'the owner runs team up (it resumes the launch)' });
        }
        if (isUnsent) {
          differences.push({
            what: `${seat.name} holds text in its input box that was never sent`,
            repair: "the owner clears or sends it in the pane; team does not type into a box it can't verify",
          });
        }
      }
      if (recorded?.rules === 'undelivered') {
        differences.push({ what: `${seat.name}: its rules were not delivered`, repair: `team remove ${seat.name} --keep, then team add ${seat.name}` });
      }
      continue;
    }
    if (seat.stopped) {
      rows.push({ name: seat.name, state: 'stopped', model: seat.display, pane: '-' });
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
      rows.push({ name: seat.name, state: 'wrong name', model: seat.display, pane: stray.pane });
      differences.push({
        what: `${seat.name}: the agent in ${stray.pane} is ${stray.name ? `named "${stray.name}"` : 'unnamed'}`,
        repair: herdrCommand(session, 'agent', 'rename', stray.pane, seat.name),
      });
      continue;
    }
    rows.push({ name: seat.name, state: 'missing', model: seat.display, pane: '-' });
    differences.push({
      what: `${seat.name} is in the file and is not running`,
      repair: anyRunning ? `team add ${seat.name}` : 'the owner runs team up',
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
      differences.push({ what: `worktree ${task}: its setup failed`, repair: `team worktree remove ${task}` });
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

  return { rows, differences: orderAndAnnotateDifferences(differences), notes };
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
  });
  return `${running.model} ${running.version} (file: ${seat.display})`;
}
