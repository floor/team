import { execFileSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';

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

export function readMachine(root: string): Machine {
  const machine: Machine = { loadPerCore: null, memoryFree: null, diskFree: null, swapFree: null, swapUsed: null };
  const cores = cpus().length;
  if (cores) machine.loadPerCore = (loadavg()[0] as number) / cores;
  try {
    const volume = statfsSync(root);
    machine.diskFree = volume.bavail * volume.bsize;
  } catch {}
  if (platform() === 'darwin') {
    const pressure = command('memory_pressure', []);
    if (pressure) machine.memoryFree = parseMemoryPressure(pressure);
    const swap = parseSwapUsage(command('sysctl', ['-n', 'vm.swapusage']) ?? '');
    if (swap && swap.total > 0) {
      machine.swapFree = swap.free;
      machine.swapUsed = swap.used;
    }
  } else {
    try {
      Object.assign(machine, parseMeminfo(readFileSync('/proc/meminfo', 'utf8')));
    } catch {}
  }
  return machine;
}
