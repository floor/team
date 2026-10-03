import { join } from 'node:path';
import { profileFor } from '../profiles/index.ts';
import { launchCommand, shellQuote } from '../profiles/profile.ts';

/** One thing `up` or `down` does, in order. */
export type Step =
  /** A command that is run. */
  | { kind: 'run'; argv: string[]; note?: string }
  /** A wait, with its time limit. */
  | { kind: 'wait'; text: string }
  /** A seat that is left out, and why. */
  | { kind: 'skip'; text: string };

export interface UpSeat {
  name: string;
  cli: string;
  launch: string;
  /** Relative to the root. */
  cwd: string;
  label: string;
  stopped: boolean;
  /** The seat's rules, as one text. */
  rules: string;
}

export interface UpInput {
  /** The project root; seats start in it. */
  root: string;
  session: string;
  /** Whether the herdr session is already running, empty. */
  sessionRunning: boolean;
  seats: readonly UpSeat[];
}

/** The variables a herdr server starts with: nothing else reaches a seat's pane. */
export const SERVER_ENVIRONMENT = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG'] as const;

/** `herdr` aimed at a session; herdr's default session takes no option. */
export function herdr(session: string, ...args: string[]): string[] {
  return session === 'default' ? ['herdr', ...args] : ['herdr', '--session', session, ...args];
}

/** What stands for a pane id that only exists once its workspace is created. */
export function paneOf(label: string): string {
  return `<pane of ${label}>`;
}

/** Every step of `team up`, in order. Nothing here runs anything. */
export function upPlan(input: UpInput): Step[] {
  const { session } = input;
  const steps: Step[] = [];

  if (!input.sessionRunning) {
    steps.push({
      kind: 'run',
      argv: ['env', '-i', ...SERVER_ENVIRONMENT.map((name) => `${name}=$${name}`), ...herdr(session, 'server')],
      note: 'detached, in a clean environment; SSH_AUTH_SOCK is passed too when it is set',
    });
    steps.push({ kind: 'wait', text: `until session ${session} is running (30 s at most)` });
  }

  for (const seat of input.seats) {
    if (seat.stopped) {
      steps.push({ kind: 'skip', text: `${seat.name}: stopped in the file; start it with \`team add ${seat.name}\`` });
      continue;
    }
    const profile = profileFor(seat.cli);
    if (!profile) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: no launch profile for \`${seat.cli}\` in this version; left out`,
      });
      continue;
    }
    const pane = paneOf(seat.label);
    steps.push({
      kind: 'run',
      argv: herdr(
        session,
        'workspace',
        'create',
        '--cwd',
        join(input.root, seat.cwd),
        '--label',
        seat.label,
        '--no-focus',
      ),
    });
    steps.push({
      kind: 'run',
      argv: herdr(session, 'pane', 'run', pane, launchCommand(profile, seat.launch, seat.rules)),
    });
    steps.push({
      kind: 'wait',
      text:
        `until ${seat.name} shows its idle prompt (${profile.idleTimeout} s at most); ` +
        'anything else is reported, its workspace closed without input, and the seat left out',
    });
    steps.push({ kind: 'run', argv: herdr(session, 'agent', 'rename', pane, seat.name) });
    if (profile.rulesOption === null) {
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'run', pane, seat.rules),
        note: 'the rules, as a first message',
      });
    }
  }

  const watchArguments = session === 'default' ? '' : ` --session ${shellQuote(session)}`;
  steps.push({
    kind: 'run',
    argv: herdr(session, 'workspace', 'create', '--cwd', input.root, '--label', 'watchdog', '--no-focus'),
  });
  steps.push({
    kind: 'run',
    argv: herdr(session, 'pane', 'run', paneOf('watchdog'), `team watch${watchArguments}`),
    note: 'a desktop notification follows when the watch exits',
  });
  return steps;
}

export interface DownSeat {
  name: string;
  cli: string;
  pane: string;
  workspace: string;
  /** What the watch's reading says of the seat: only a free seat is stopped. */
  state: 'free' | 'working' | 'blocked' | 'unknown' | 'unsent';
}

export interface DownInput {
  session: string;
  /** The running seats the file and the state name; nothing else is closed. */
  seats: readonly DownSeat[];
  /** Agents in the session that the file and the state don't name. */
  extra: number;
  /** The watch's pid, when its state records one that is alive. */
  watchPid: number | null;
  /** The caller's own seat, and the coordinator's and operator's, when a seat calls. */
  keep: readonly string[];
}

const LEFT: Record<Exclude<DownSeat['state'], 'free'>, string> = {
  working: 'is working (`--wait` waits for it)',
  blocked: 'is blocked at a prompt, which `team` never answers',
  unknown: 'shows a screen the profile does not recognise',
  unsent: 'holds unsent text in its input box',
};

/** Every step of `team down`, in order. Nothing here runs anything. */
export function downPlan(input: DownInput): Step[] {
  const { session } = input;
  const steps: Step[] = [];
  let left = input.extra;

  for (const seat of input.seats) {
    if (input.keep.includes(seat.name)) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: left running; only the owner stops the coordinator's or the operator's seat`,
      });
      left++;
      continue;
    }
    const profile = profileFor(seat.cli);
    if (!profile) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: no launch profile for \`${seat.cli}\` in this version; left running`,
      });
      left++;
      continue;
    }
    if (seat.state !== 'free') {
      steps.push({ kind: 'skip', text: `${seat.name}: ${LEFT[seat.state]}; left running` });
      left++;
      continue;
    }
    steps.push({ kind: 'run', argv: herdr(session, 'pane', 'run', seat.pane, profile.exit) });
    steps.push({
      kind: 'wait',
      text: `until ${seat.name}'s pane is back at its shell (${profile.exitTimeout} s at most); on a time-out it is left as it is`,
    });
    steps.push({ kind: 'run', argv: herdr(session, 'workspace', 'close', seat.workspace) });
  }

  if (input.watchPid !== null) steps.push({ kind: 'run', argv: ['kill', String(input.watchPid)], note: 'the watch' });

  if (session === 'default') {
    steps.push({ kind: 'skip', text: "session default: herdr's default session is never stopped" });
  } else if (left > 0) {
    steps.push({
      kind: 'skip',
      text: `session ${session}: not stopped, ${left} agent${left === 1 ? '' : 's'} left in it`,
    });
  } else {
    steps.push({ kind: 'run', argv: ['herdr', 'session', 'stop', session] });
  }
  return steps;
}

/** The plan as `--dry-run` prints it. */
export function formatPlan(steps: readonly Step[]): string {
  const lines = steps.map((step) => {
    if (step.kind === 'run') {
      const command = step.argv
        .map((word) => (/^<pane of .+>$|^[A-Z_]+=\$[A-Z_]+$/.test(word) ? word : shellQuote(word)))
        .join(' ');
      return `+ ${command}${step.note ? `\n    (${step.note})` : ''}`;
    }
    return step.kind === 'wait' ? `  wait ${step.text}` : `  skip ${step.text}`;
  });
  return `${lines.join('\n')}\ndry run: nothing was run\n`;
}
