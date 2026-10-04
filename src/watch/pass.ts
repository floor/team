// One pass of the watch: the core. It builds one observation per seat before any check runs,
// runs the registered checks in the order it owns, applies the report-once rule, and dials the
// nudge. A check never reads herdr, a screen or the file itself — only the observation it is
// handed (RFC 0002 § 4.2).
import { WATCH_CHECKS_CHANGED } from '../approve/fingerprint.ts';
import { observe, recall, type Seen } from '../budgets/readings.ts';
import type { CheckOutcome } from '../budgets/run.ts';
import type { TeamFile } from '../file/types.ts';
import { quotaFor } from '../profiles/profile.ts';
import { figuresOf } from '../profiles/quota.ts';
import type { SessionState } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { seatModel } from '../status/statusline.ts';
import {
  ALWAYS_ON,
  type Attention,
  type CheckContext,
  type Report,
  type SeatCheck,
  type SeatHistory,
  type SeatObservation,
  type TeamCheck,
  type TeamObservation,
} from './check.ts';
import { minutes } from './check.ts';
import { attention } from './checks/attention.ts';
import { approval } from './checks/approval.ts';
import { budget } from './checks/budget.ts';
import { disk } from './checks/disk.ts';
import { extra } from './checks/extra.ts';
import { idle } from './checks/idle.ts';
import { load } from './checks/load.ts';
import { memory as memoryCheck } from './checks/memory.ts';
import { missing } from './checks/missing.ts';
import { modelDrift } from './checks/model-drift.ts';
import { swapFree } from './checks/swap-free.ts';
import { swapGrowth } from './checks/swap-growth.ts';
import { teamIdle } from './checks/team-idle.ts';
import { unsent } from './checks/unsent.ts';
import type { Machine } from './machine.ts';
import { readScreen, type Screen } from './screen.ts';

// What the watch remembers between passes. It lives in the watch's process: a restarted watch
// starts its timers again, and reports again what is still true.
export type Memory = {
  // The seats' shared history, per seat name: the clock the idle check counts from.
  history: Record<string, SeatHistory>;
  // Each check's own slot, by kind. The core keeps them; no check reads another's.
  slots: Record<string, unknown>;
  // Conditions that were reported and have not cleared since.
  active: Set<string>;
  pending: string[];
  pendingSince: number | null;
};

export function newMemory(): Memory {
  return { history: {}, slots: {}, active: new Set(), pending: [], pendingSince: null };
}

export type { Report } from './check.ts';

// The one line the watch types into the operator's pane. Fixed, and free of report text: a dialog
// can open between the screen read and the typing, and a digit in the line would answer it. The
// reports go to the log and to the desktop notification; the line only says where they are.
export const NUDGE_TEXT = 'Team watch: reports are waiting in .agents/team.log';

export type PassResult = {
  reports: Report[];
  // The one line to type into the operator's pane, when the operator is free. `pending` holds the
  // report texts it stands for, so a delivery that fails puts them back rather than losing them.
  nudge: { pane: string; text: string; pending: string[] } | null;
  // What to notify instead, when a nudge has waited too long.
  fallback: string | null;
  // The readings that count, to be saved: the state's, with this pass's figures folded in (§ 4.4).
  readings: Seen[];
};

// The seat checks, in the order their reports land in the log; the team checks, after them. The
// order is the core's: a seat's wrong model is reported before its permission prompt, and every
// seat before the team. Disabling a check in the file's `watch.checks` takes it out of the run,
// except the four that can't be turned off.
export const SEAT_CHECKS: SeatCheck[] = [missing, modelDrift, attention, unsent, idle];
export const TEAM_CHECKS: TeamCheck[] = [extra, teamIdle, approval, load, memoryCheck, disk, swapFree, swapGrowth, budget];

// The one exclusive reading of a seat's screen and herdr status. herdr can report a seat at a
// permission prompt as idle, so the screen decides first.
function attentionOf(screen: Screen, status: string, quiet: boolean): Attention {
  if (screen.kind === 'permission' || screen.kind === 'trust') return 'permission';
  if (screen.kind === 'question') return 'question';
  if (status === 'blocked') return 'blocked';
  if (!quiet && status !== 'working') return 'unknown';
  return null;
}

// What one pass is handed: the file, the session, the observed world, the clock, the watch's
// memory, and what the caller knows that the world does not. `approval` is how the file differs
// from the approved one: [] when it doesn't, null when it was never approved, undefined when that
// wasn't looked at. `watch` and `budgets` are the sections in force — the approved ones, or the
// defaults while the file's own are not approved — and the checks read those, never the file's.
// `outcomes` is what the accounts' check commands read outside the pass, when the watch last ran
// them.
export type PassInput = {
  team: TeamFile;
  state: SessionState;
  live: Live;
  machine: Machine;
  now: number;
  memory: Memory;
  approval?: string[] | null;
  watch?: TeamFile['watch'];
  outcomes?: readonly CheckOutcome[];
  budgets?: TeamFile['budgets'];
};

// One pass of the watch. Pure: it reads what it is handed and changes only `memory`.
export function pass({
  team,
  state,
  live,
  machine,
  now,
  memory,
  approval,
  watch = team.watch,
  outcomes = [],
  budgets = team.budgets,
}: PassInput): PassResult {
  const reports: Report[] = [];
  const current = new Set<string>();
  // Reported when it starts, and again only after it has cleared.
  const once = (key: string, text: string, to: Report['to'] = 'operator'): Report | null => {
    current.add(key);
    return memory.active.has(key) ? null : { key, text, to };
  };

  const known = new Set<string>();
  const workers: { idle: boolean }[] = [];
  const observations: SeatObservation[] = [];

  // A stopped seat is kept in the file and not started; should its owner start one by hand, herdr
  // shows it running, and the watch gives it a parked seat's treatment: attention (permission,
  // trust, question, blocked) and unsent text are reported, idle is not — and it is never an agent
  // the file doesn't hold. A stopped seat that is not running is the normal state, and draws nothing.
  const seats = [
    ...team.seats.map((seat) => ({
      name: seat.name,
      cli: seat.cli,
      vendor: seat.vendor,
      parked: seat.parked || seat.stopped,
      stopped: seat.stopped,
      seat,
    })),
    ...Object.entries(state.seats).filter(([, recorded]) => recorded.temporary).map(([name, recorded]) => {
      // A temporary seat signs like the seat it is like: its CLI, and its account.
      const like = team.seats.find((seat) => seat.name === recorded.temporary?.like);
      return { name, cli: like?.cli ?? '', vendor: like?.vendor ?? '', parked: false, stopped: false, seat: undefined };
    }),
  ];

  for (const { name, cli, vendor, parked, stopped, seat } of seats) {
    const agent = live.agents.find((candidate) => candidate.name === name);
    const lead = name === team.coordinator || name === team.operator;
    if (!agent) {
      delete memory.history[name];
      observations.push({
        name,
        seat,
        agent: undefined,
        herdr: live.running,
        screen: { kind: 'unknown' },
        cli,
        vendor,
        quota: [],
        running: false,
        quiet: false,
        working: false,
        prompt: false,
        lead,
        parked,
        stopped,
        attention: null,
        model: null,
        history: { lastWorking: undefined, idleSince: undefined },
      });
      continue;
    }
    known.add(agent.pane);
    const pane = live.screens[agent.pane];
    const screen = readScreen(cli, pane);
    const quiet = agent.status === 'idle' || agent.status === 'done';
    // Working is herdr's word or the screen's: a seat mid-turn is never idle, whatever its
    // status says.
    const working = agent.status === 'working' || screen.kind === 'working';
    const prompt = screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question';
    if (!lead && !parked) workers.push({ idle: quiet && !working && !prompt });

    // The history the idle clock counts from. A seat seen working starts it again; a seat quiet
    // with no work behind it was already idle when the watch started, and counts from then.
    const history = (memory.history[name] ??= { lastWorking: undefined, idleSince: undefined });
    if (working) {
      history.lastWorking = now;
      delete history.idleSince;
    } else if (quiet && !prompt && !lead && !parked && history.lastWorking === undefined) {
      history.idleSince ??= now;
    }

    observations.push({
      name,
      seat,
      agent,
      herdr: live.running,
      screen,
      cli,
      vendor,
      quota: pane === undefined ? [] : figuresOf(quotaFor(cli), pane),
      running: true,
      quiet,
      working,
      prompt,
      lead,
      parked,
      stopped,
      attention: attentionOf(screen, agent.status, quiet),
      model: seat ? seatModel(seat, live.screens[agent.pane]) : null,
      history: { lastWorking: history.lastWorking, idleSince: history.idleSince },
    });
  }

  // The figures this pass saw, folded into the readings the state keeps (§ 4.3). Only an account
  // whose `sources` name `status_line` takes a screen reading: a check-only account never records
  // one here, and neither does an account the budgets in force don't name (#50).
  let readings = recall(state.budgets);
  for (const seat of observations) {
    if (!seat.running) continue;
    for (const figure of seat.quota) {
      if (budgets.accounts[figure.account]?.sources.includes('status_line')) {
        readings = observe(readings, figure, seat.name, now);
      }
    }
  }

  const teamObservation: TeamObservation = {
    team,
    state,
    live,
    machine,
    limits: team.machine,
    seats: observations,
    known,
    workers,
    approval,
    readings,
    outcomes,
  };

  const ctx: CheckContext = {
    now,
    watch,
    budgets,
    once,
    memory: <T>(kind: string, start: () => T): T => {
      if (!Object.hasOwn(memory.slots, kind)) memory.slots[kind] = start();
      return memory.slots[kind] as T;
    },
  };

  // The four § 4.2 keeps out of `watch.checks` run whatever the file says: the validation refuses
  // them, and this holds even for a file that reached memory another way.
  //
  // And nothing is turned off until the owner approves (RFC 0002 § 4.2): a file whose
  // `watch.checks` differs from the approved one, a file never approved, and an approval that
  // wasn't looked at keep every check running and report the difference instead. A difference in
  // some other section leaves the checks turned off as approved — the owner owns both questions.
  const approved = Array.isArray(approval) && !approval.includes(WATCH_CHECKS_CHANGED);
  const off = approved ? new Set(team.watch.checks) : new Set<string>();
  const enabled = (name: string) => ALWAYS_ON.includes(name) || !off.has(name);
  for (const seat of observations) {
    for (const check of SEAT_CHECKS) if (enabled(check.name)) reports.push(...check.run(seat, ctx));
  }
  for (const check of TEAM_CHECKS) if (enabled(check.name)) reports.push(...check.run(teamObservation, ctx));

  memory.active = current;

  // The nudge: kept until the operator is free, never typed into anything but an empty idle prompt.
  for (const report of reports) if (report.to === 'operator') memory.pending.push(report.text);
  let nudge: PassResult['nudge'] = null;
  let fallback: string | null = null;
  if (memory.pending.length) {
    memory.pendingSince ??= now;
    const operator = live.agents.find((agent) => agent.name === team.operator);
    const cli = team.seats.find((seat) => seat.name === team.operator)?.cli ?? '';
    const free = operator !== undefined && (operator.status === 'idle' || operator.status === 'done')
      && readScreen(cli, live.screens[operator.pane]).kind === 'idle';
    if (operator && free) {
      nudge = { pane: operator.pane, text: NUDGE_TEXT, pending: memory.pending.slice() };
    } else if (now - memory.pendingSince >= watch.nudgeWait * 1000) {
      fallback = `the operator could not be nudged for ${minutes(now - memory.pendingSince)} minutes; ${memory.pending.length} report(s) wait: ${memory.pending.join('; ')}`;
    }
    if (nudge || fallback) {
      memory.pending = [];
      memory.pendingSince = null;
    }
  }
  return { reports, nudge, fallback, readings };
}
