import type { TeamFile } from '../file/types.ts';
import type { SessionState } from '../state.ts';
import { WATCH_LABEL } from '../status/compare.ts';
import type { Live } from '../status/compare.ts';
import { seatModel } from '../status/statusline.ts';
import type { Machine } from './machine.ts';
import { readScreen } from './screen.ts';

// What the watch remembers between passes. It lives in the watch's process: a restarted watch
// starts its timers again, and reports again what is still true.
export type Memory = {
  // When the watch first saw a seat quiet: the clock for a seat it has never seen working.
  idleSince: Record<string, number>;
  // When each seat was last seen working — herdr said working, or its screen showed a running
  // turn. The idle duration counts from here, the same for every profile.
  lastWorking: Record<string, number>;
  idleTold: Record<string, number>;
  unsentSince: Record<string, number>;
  // Conditions that were reported and have not cleared since.
  active: Set<string>;
  teamIdleSince: number | null;
  teamIdleTold: boolean;
  swap: { at: number; used: number }[];
  pending: string[];
  pendingSince: number | null;
};

export function newMemory(): Memory {
  return { idleSince: {}, lastWorking: {}, idleTold: {}, unsentSince: {}, active: new Set(), teamIdleSince: null, teamIdleTold: false, swap: [], pending: [], pendingSince: null };
}

// A report says what is, never what to do about it. `to` is who can act on it.
export type Report = { key: string; text: string; to: 'operator' | 'owner' };

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
};

const minutes = (ms: number) => Math.floor(ms / 60_000);
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

// One pass of the watch. Pure: it reads what it is handed and changes only `memory`.
// `approval` is how the file differs from the approved one: [] when it doesn't, null when it was
// never approved, undefined when that wasn't looked at.
export function pass(
  team: TeamFile, state: SessionState, live: Live, machine: Machine, now: number, memory: Memory,
  approval?: string[] | null,
): PassResult {
  const reports: Report[] = [];
  const current = new Set<string>();
  // Reported when it starts, and again only after it has cleared.
  const once = (key: string, text: string, to: Report['to'] = 'operator') => {
    current.add(key);
    if (!memory.active.has(key)) reports.push({ key, text, to });
  };

  const labels = new Map(live.workspaces.map((workspace) => [workspace.id, workspace.label]));
  const known = new Set<string>();
  const workers: { idle: boolean }[] = [];

  // A stopped seat is kept in the file and not started; should its owner start one by hand, herdr
  // shows it running, and the watch gives it a parked seat's treatment: attention (permission,
  // trust, question, blocked) and unsent text are reported, idle is not — and it is never an agent
  // the file doesn't hold. A stopped seat that is not running is the normal state, and draws nothing.
  const seats = [
    ...team.seats.map((seat) => ({
      name: seat.name,
      cli: seat.cli,
      parked: seat.parked || seat.stopped,
      stopped: seat.stopped,
      seat,
    })),
    ...Object.entries(state.seats).filter(([, recorded]) => recorded.temporary).map(([name, recorded]) => ({
      name,
      cli: team.seats.find((seat) => seat.name === recorded.temporary?.like)?.cli ?? '',
      parked: false,
      stopped: false,
      seat: undefined,
    })),
  ];

  for (const { name, cli, parked, stopped, seat } of seats) {
    const agent = live.agents.find((candidate) => candidate.name === name);
    if (!agent) {
      delete memory.idleSince[name];
      delete memory.lastWorking[name];
      delete memory.unsentSince[name];
      // A stopped seat is not started: absent from herdr is its normal state, not a missing seat.
      if (live.running && !stopped) once(`missing:${name}`, `${name} is in the file and is not running`);
      continue;
    }
    known.add(agent.pane);
    const lead = name === team.coordinator || name === team.operator;
    const screen = readScreen(cli, live.screens[agent.pane]);
    const quiet = agent.status === 'idle' || agent.status === 'done';
    // Working is herdr's word or the screen's: a seat mid-turn is never idle, whatever its
    // status says.
    const working = agent.status === 'working' || screen.kind === 'working';
    const prompt = screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question';
    if (!lead && !parked) workers.push({ idle: quiet && !working && !prompt });

    if (seat) {
      const running = seatModel(seat, live.screens[agent.pane]);
      if (running && (running.model !== seat.model || running.version !== seat.version)) {
        once(`model:${name}`, `${name} runs ${running.model} ${running.version}; the file says ${seat.model} ${seat.version}: it signs with the wrong model`);
      }
    }

    // herdr can report a seat at a permission prompt as idle, so the screen decides first.
    if (screen.kind === 'permission' || screen.kind === 'trust') {
      once(`blocked:${name}`, `${name} waits at a permission prompt: its owner's to answer`, 'owner');
    } else if (screen.kind === 'question') {
      once(`question:${name}`, `${name} asked a question: the operator's to act on`);
    } else if (agent.status === 'blocked') {
      once(`blocked:${name}`, `${name} is blocked, and its screen is not one the watch recognises`, 'owner');
    } else if (!quiet && agent.status !== 'working') {
      once(`unknown:${name}`, `${name}: herdr reports the status "${agent.status}"`);
    }

    if (!quiet || working || prompt) {
      delete memory.idleTold[name];
      delete memory.unsentSince[name];
      if (working) {
        // The one event every profile's idle duration counts from.
        memory.lastWorking[name] = now;
        delete memory.idleSince[name];
      }
      continue;
    }

    if (screen.kind === 'unsent') {
      memory.unsentSince[name] ??= now;
      if (now - (memory.unsentSince[name] as number) >= team.watch.unsentAfter * 1000) {
        once(`unsent:${name}`, `${name} holds text in its input box that was never sent`);
      }
    } else delete memory.unsentSince[name];

    if (lead || parked) continue;
    // The idle duration counts from the last moment the seat was seen working. A seat never
    // seen working was already idle when the watch started: it is reported that way, with no
    // duration from another source.
    const worked = memory.lastWorking[name];
    if (worked === undefined) memory.idleSince[name] ??= now;
    const since = now - (worked ?? (memory.idleSince[name] as number));
    const told = memory.idleTold[name];
    if (since >= team.watch.idleFirst * 1000 && (told === undefined || now - told >= team.watch.idleRepeat * 1000)) {
      memory.idleTold[name] = now;
      reports.push({
        key: `idle:${name}`,
        text: worked === undefined
          ? `${name} has been idle since the watch started`
          : `${name} has been idle for ${minutes(since)} minutes`,
        to: 'operator',
      });
    }
  }

  for (const agent of live.agents) {
    if (known.has(agent.pane) || labels.get(agent.workspace) === WATCH_LABEL) continue;
    once(`extra:${agent.pane}`, `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane}) is running and is not in the file`);
  }

  if (workers.length && workers.every((worker) => worker.idle)) {
    memory.teamIdleSince ??= now;
    if (!memory.teamIdleTold && now - memory.teamIdleSince >= team.watch.teamIdle * 1000) {
      memory.teamIdleTold = true;
      reports.push({ key: 'team-idle', text: 'every agent is idle', to: 'operator' });
    }
  } else {
    memory.teamIdleSince = null;
    memory.teamIdleTold = false;
  }

  if (approval === null) once('approval', 'the file was never approved on this machine', 'owner');
  else if (approval?.length) once('approval', `the file differs from the approved one: ${approval.join('; ')}`, 'owner');

  const limits = team.machine;
  if (machine.loadPerCore !== null && machine.loadPerCore > limits.loadMax) {
    once('load', `the load is ${machine.loadPerCore.toFixed(1)} per core, above ${limits.loadMax}`, 'owner');
  }
  if (machine.memoryFree !== null && machine.memoryFree < limits.memoryMin) {
    once('memory', `free memory is ${Math.round(machine.memoryFree)}%, below ${limits.memoryMin}%`, 'owner');
  }
  if (machine.diskFree !== null && machine.diskFree < limits.diskMin) {
    once('disk', `free disk is ${gb(machine.diskFree)}, below ${gb(limits.diskMin)}`, 'owner');
  }
  if (machine.swapFree !== null && machine.swapFree < limits.swapFreeMin) {
    once('swap-free', `free swap is ${gb(machine.swapFree)}, below ${gb(limits.swapFreeMin)}`, 'owner');
  }
  if (machine.swapUsed !== null) {
    memory.swap.push({ at: now, used: machine.swapUsed });
    memory.swap = memory.swap.filter((sample) => now - sample.at <= limits.swapGrowthWindow * 1000);
    const growth = machine.swapUsed - Math.min(...memory.swap.map((sample) => sample.used));
    if (growth > limits.swapGrowthMax) {
      once('swap-growth', `swap grew by ${gb(growth)} in ${minutes(limits.swapGrowthWindow * 1000)} minutes, above ${gb(limits.swapGrowthMax)}`, 'owner');
    }
  }

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
    } else if (now - memory.pendingSince >= team.watch.nudgeWait * 1000) {
      fallback = `the operator could not be nudged for ${minutes(now - memory.pendingSince)} minutes; ${memory.pending.length} report(s) wait: ${memory.pending.join('; ')}`;
    }
    if (nudge || fallback) {
      memory.pending = [];
      memory.pendingSince = null;
    }
  }
  return { reports, nudge, fallback };
}
