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
  idleSince: Record<string, number>;
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
  return { idleSince: {}, idleTold: {}, unsentSince: {}, active: new Set(), teamIdleSince: null, teamIdleTold: false, swap: [], pending: [], pendingSince: null };
}

// A report says what is, never what to do about it. `to` is who can act on it.
export type Report = { key: string; text: string; to: 'operator' | 'owner' };

export type PassResult = {
  reports: Report[];
  // The one line to type into the operator's pane, when the operator is free.
  nudge: { pane: string; text: string } | null;
  // What to notify instead, when a nudge has waited too long.
  fallback: string | null;
};

const minutes = (ms: number) => Math.floor(ms / 60_000);
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

// One pass of the watch. Pure: it reads what it is handed and changes only `memory`.
export function pass(team: TeamFile, state: SessionState, live: Live, machine: Machine, now: number, memory: Memory): PassResult {
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

  const seats = [
    ...team.seats.filter((seat) => !seat.stopped).map((seat) => ({ name: seat.name, cli: seat.cli, parked: seat.parked, seat })),
    ...Object.entries(state.seats).filter(([, recorded]) => recorded.temporary).map(([name, recorded]) => ({
      name,
      cli: team.seats.find((seat) => seat.name === recorded.temporary?.like)?.cli ?? '',
      parked: false,
      seat: undefined,
    })),
  ];

  for (const { name, cli, parked, seat } of seats) {
    const agent = live.agents.find((candidate) => candidate.name === name);
    if (!agent) {
      delete memory.idleSince[name];
      delete memory.unsentSince[name];
      if (live.running) once(`missing:${name}`, `${name} is in the file and is not running`);
      continue;
    }
    known.add(agent.pane);
    const lead = name === team.coordinator || name === team.operator;
    const screen = readScreen(cli, live.screens[agent.pane]);
    const quiet = agent.status === 'idle' || agent.status === 'done';
    if (!lead && !parked) workers.push({ idle: quiet && screen.kind !== 'permission' && screen.kind !== 'question' });

    if (seat) {
      const running = seatModel(seat, live.screens[agent.pane]);
      if (running && (running.model !== seat.model || running.version !== seat.version)) {
        once(`model:${name}`, `${name} runs ${running.model} ${running.version}; the file says ${seat.model} ${seat.version}: it signs with the wrong model`);
      }
    }

    // herdr can report a seat at a permission prompt as idle, so the screen decides first.
    if (screen.kind === 'permission') {
      once(`blocked:${name}`, `${name} waits at a permission prompt: its owner's to answer`, 'owner');
    } else if (screen.kind === 'question') {
      once(`question:${name}`, `${name} asked a question: the operator's to act on`);
    } else if (agent.status === 'blocked') {
      once(`blocked:${name}`, `${name} is blocked, and its screen is not one the watch recognises`, 'owner');
    } else if (!quiet && agent.status !== 'working') {
      once(`unknown:${name}`, `${name}: herdr reports the status "${agent.status}"`);
    }

    if (!quiet || screen.kind === 'permission' || screen.kind === 'question') {
      delete memory.idleSince[name];
      delete memory.idleTold[name];
      delete memory.unsentSince[name];
      continue;
    }

    if (screen.kind === 'unsent') {
      memory.unsentSince[name] ??= now;
      if (now - (memory.unsentSince[name] as number) >= team.watch.unsentAfter * 1000) {
        once(`unsent:${name}`, `${name} holds text in its input box that was never sent`);
      }
    } else delete memory.unsentSince[name];

    if (lead || parked) continue;
    memory.idleSince[name] ??= now;
    const since = now - (memory.idleSince[name] as number);
    const told = memory.idleTold[name];
    if (since >= team.watch.idleFirst * 1000 && (told === undefined || now - told >= team.watch.idleRepeat * 1000)) {
      memory.idleTold[name] = now;
      reports.push({ key: `idle:${name}`, text: `${name} has been idle for ${minutes(since)} minutes`, to: 'operator' });
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
      nudge = { pane: operator.pane, text: `Team watch: ${memory.pending.join('; ')}.` };
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
