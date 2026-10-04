import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';

// The machine's figures, each null when it can't be read here: a figure that isn't read is never
// reported as fine or as bad.
export type Machine = {
  loadPerCore: number | null;
  memoryFree: number | null;   // percent
  diskFree: number | null;     // bytes, on the project's volume
  swapFree: number | null;     // bytes; null when the machine has no swap
  swapUsed: number | null;     // bytes
};

function command(name: string, args: string[]): string | null {
  try {
    return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return null;
  }
}

// "total = 24576.00M  used = 23261.25M  free = 1314.75M", as macOS's vm.swapusage prints it.
export function parseSwapUsage(text: string): { total: number; used: number; free: number } | null {
  const read = (name: string) => {
    const match = new RegExp(`${name} = ([0-9.]+)([KMG])`).exec(text);
    if (!match) return null;
    return Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[match[2] as string]!;
  };
  const total = read('total');
  const used = read('used');
  const free = read('free');
  return total === null || used === null || free === null ? null : { total, used, free };
}

// "System-wide memory free percentage: 44%", the last line of macOS's memory_pressure.
export function parseMemoryPressure(text: string): number | null {
  const match = /free percentage:\s*([0-9]+)%/.exec(text);
  return match ? Number(match[1]) : null;
}

// "0.52 0.58 0.59 1/1234 5678", as /proc/loadavg holds it: the one-minute average first.
export function parseLoadavg(text: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s/.exec(text);
  return match ? Number(match[1]) : null;
}

// One file of a /proc tree, or null when this machine doesn't have it. `proc` is the tree's root,
// a parameter so a test can read a captured one.
function procFile(proc: string, name: string): string | null {
  try {
    return readFileSync(`${proc}/${name}`, 'utf8');
  } catch {
    return null;
  }
}

export function parseMeminfo(text: string): { memoryFree: number | null; swapFree: number | null; swapUsed: number | null } {
  const kb = (name: string) => {
    const match = new RegExp(`^${name}:\\s+([0-9]+) kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    memoryFree: total && available !== null ? (available / total) * 100 : null,
    swapFree: swapTotal ? swapFree : null,
    swapUsed: swapTotal && swapFree !== null ? swapTotal - swapFree : null,
  };
}

// This platform's figures: macOS's commands on darwin, Linux's /proc everywhere Linux runs.
// `platform` and `proc` are parameters for the tests; the command passes neither.
export function readMachine(root: string, platform: string = process.platform, proc = '/proc'): Machine {
  const machine: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapFree: null, swapUsed: null };
  const cores = cpus().length;
  try {
    const volume = statfsSync(root);
    machine.diskFree = volume.bavail * volume.bsize;
  } catch {}
  if (platform === 'darwin') {
    if (cores) machine.loadPerCore = (loadavg()[0] as number) / cores;
    const pressure = command('memory_pressure', []);
    if (pressure) machine.memoryFree = parseMemoryPressure(pressure);
    const swap = parseSwapUsage(command('sysctl', ['-n', 'vm.swapusage']) ?? '');
    if (swap && swap.total > 0) {
      machine.swapFree = swap.free;
      machine.swapUsed = swap.used;
    }
  } else if (platform === 'linux') {
    // /proc is always there, and reading it is what the platform's own tools do.
    const load = procFile(proc, 'loadavg');
    const one = load === null ? null : parseLoadavg(load);
    if (cores && one !== null) machine.loadPerCore = one / cores;
    const info = procFile(proc, 'meminfo');
    if (info !== null) Object.assign(machine, parseMeminfo(info));
  } else if (cores) {
    machine.loadPerCore = (loadavg()[0] as number) / cores;
  }
  return machine;
}
