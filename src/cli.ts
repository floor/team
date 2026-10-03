#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command, Io } from './io.ts';

// Each command is loaded only when it is called. A slice adds its line here.
const commands: Record<string, () => Promise<{ default: Command } | Record<string, Command>>> = {
  check: () => import('./commands/check.ts'),
};

const USAGE = `team: set up, change and watch a project's team of AI agents

Usage: team <command> [options]

Commands:
{commands}

Options:
  --version   print the version
  --help      print this text

The team is declared in <project>/.agents/team.yaml.
`;

export function version(): string {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(text) as { version: string }).version;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  const names = Object.keys(commands);
  const usage = USAGE.replace('{commands}', names.length ? names.map((n) => `  ${n}`).join('\n') : '  (none in this build)');
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    io.stdout(usage);
    return name ? 0 : 2;
  }
  if (name === '--version' || name === '-V') {
    io.stdout(`${version()}\n`);
    return 0;
  }
  const load = commands[name];
  if (!load) {
    io.stderr(`team: unknown command "${name}"\n\n${usage}`);
    return 2;
  }
  const module = await load();
  const command = ('default' in module ? module.default : module[name]) as Command | undefined;
  if (!command) throw new Error(`the module of "${name}" exports no command`);
  return command(rest, io);
}

export function processIo(): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), processIo()).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`team: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
