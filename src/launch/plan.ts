import { join } from 'node:path';
import { profileFor } from '../profiles/index.ts';
import { launchCommand, shellQuote } from '../profiles/profile.ts';

/**
 * What running a step does. The printed command stays in `argv`; this is how the live command
 * performs that same step, so a dry run and a real run share one plan.
 */
export type Op =
  | { do: 'server'; session: string }
  | { do: 'wait-session'; session: string; seconds: number }
  | { do: 'lobby'; path: string }
  | { do: 'create'; seat?: string; label: string; cwd: string; notice?: string }
  | { do: 'launch'; seat: string; label: string; command: string; pane?: string; notice?: string }
  | { do: 'refuse'; seat: string; why: string }
  | { do: 'idle'; seat: string; label: string; cli: string; seconds: number; pane?: string; workspace?: string; notice?: string }
  | { do: 'rename'; seat: string; label: string; seconds: number; rules: 'option' | 'message'; pane?: string }
  | { do: 'deliver'; seat: string; label: string; cli: string; rules: string; seconds: number; pane?: string; notice?: string }
  | { do: 'ready'; seat: string; rules: 'option' | 'message'; notice?: string }
  | { do: 'watch'; label: string; command: string }
  | { do: 'type'; seat: string; pane: string; text: string }
  | { do: 'gone'; seat: string; pane: string; seconds: number }
  | { do: 'close'; seat: string; workspace: string }
  | { do: 'kill'; pid: number }
  | { do: 'stop'; session: string };

/** One thing `up` or `down` does, in order. */
export type Step =
  /** A command that is run. */
  | { kind: 'run'; argv: string[]; note?: string; do?: Op }
  /** A wait, with its time limit. */
  | { kind: 'wait'; text: string; note?: string; do?: Op }
  /** A seat that is left out, and why. */
  | { kind: 'skip'; text: string; note?: string; do?: Op };

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
  /** Set when a running session is being resumed. Omitted: launch from the start. */
  stage?: 'launched' | 'named' | 'ready';
  pane?: string;
  workspace?: string;
  /** Herdr already lists an agent in the recorded pane. */
  agentLive?: boolean;
  /** The seat works in worktrees: it waits in the lobby until a brief names its worktree. */
  lobby?: boolean;
  /**
   * Set when the seat's own launch line can't run where the seat starts — the program is not
   * there, or a relative path in it resolves from neither the start folder nor the root. The
   * seat is left out before its workspace is made; the other seats go on.
   */
  launchProblem?: string;
  /**
   * Set when a counted reading is inside the reserve, or the figure is unknown
   * or a first sight. A refusal stops the seat only when this plan would launch it.
   */
  budget?: { kind: 'refuse'; why: string } | { kind: 'unknown'; account: string; text: string };
}

export interface UpInput {
  /** The project root; seats start in it. */
  root: string;
  session: string;
  /** Whether the herdr session is already running, empty. */
  sessionRunning: boolean;
  seats: readonly UpSeat[];
  /** The watch's pid is alive, so no second watch is started. */
  watchAlive?: boolean;
  /** The command the watchdog pane runs. Defaults to `team watch`. */
  watchLine?: string;
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
      do: { do: 'server', session },
    });
    steps.push({
      kind: 'wait',
      text: `until session ${session} is running (30 s at most)`,
      do: { do: 'wait-session', session, seconds: 30 },
    });
  }

  const lobbies = new Set<string>();
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
    if (seat.stage === 'ready') {
      steps.push({ kind: 'skip', text: `${seat.name}: already ready; left as it is` });
      continue;
    }
    const pane = seat.pane ?? paneOf(seat.name);
    const cwd = join(input.root, seat.cwd);
    const fresh = seat.stage === undefined || !seat.pane;
    // The same condition as the launch step below. A seat already running keeps
    // its idle wait, rename and rules, and hears the reading as a notice.
    const wouldLaunch = fresh || (seat.stage === 'launched' && !seat.agentLive);
    if (seat.launchProblem && wouldLaunch) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: would refuse: ${seat.launchProblem}`,
        do: { do: 'refuse', seat: seat.name, why: seat.launchProblem },
      });
      continue;
    }
    if (seat.budget?.kind === 'refuse' && wouldLaunch) {
      steps.push({
        kind: 'skip',
        text: `${seat.name}: would refuse: ${seat.budget.why}`,
        do: { do: 'refuse', seat: seat.name, why: seat.budget.why },
      });
      continue;
    }
    let notice: string | undefined;
    if (seat.budget?.kind === 'unknown') notice = seat.budget.text;
    else if (seat.budget?.kind === 'refuse') notice = seat.budget.why;
    const takeNotice = (): string | undefined => {
      const text = notice;
      notice = undefined;
      return text;
    };
    if (fresh) {
      // The lobby is one folder for the team, made before the first seat waits in it.
      if (seat.lobby && !lobbies.has(cwd)) {
        lobbies.add(cwd);
        steps.push({
          kind: 'run',
          argv: ['mkdir', '-p', cwd],
          note: 'the lobby: where a seat that works in worktrees waits, outside every protected checkout',
          do: { do: 'lobby', path: cwd },
        });
      }
      const said = takeNotice();
      steps.push({
        kind: 'run',
        argv: herdr(session, 'workspace', 'create', '--cwd', cwd, '--label', seat.label, '--no-focus'),
        ...(said ? { note: `${said}; would launch` } : {}),
        do: { do: 'create', seat: seat.name, label: seat.label, cwd, ...(said ? { notice: said } : {}) },
      });
    }
    const command = launchCommand(profile, seat.launch, seat.rules);
    if (fresh || (seat.stage === 'launched' && !seat.agentLive)) {
      const said = takeNotice();
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'run', pane, command),
        ...(said ? { note: `${said}; would launch` } : {}),
        do: { do: 'launch', seat: seat.name, label: seat.label, command, pane: seat.pane, ...(said ? { notice: said } : {}) },
      });
    }
    const rules = profile.rulesOption === null ? 'message' : 'option';
    if (seat.stage !== 'named') {
      const said = takeNotice();
      steps.push({
        kind: 'wait',
        text:
          `until ${seat.name} shows its idle prompt (${profile.idleTimeout} s at most); ` +
          'anything else is reported, its workspace closed without input, and the seat left out',
        ...(said ? { note: said } : {}),
        do: {
          do: 'idle',
          seat: seat.name,
          label: seat.label,
          cli: seat.cli,
          seconds: profile.idleTimeout,
          pane: seat.pane,
          workspace: seat.workspace,
          ...(said ? { notice: said } : {}),
        },
      });
      steps.push({
        kind: 'run',
        argv: herdr(session, 'agent', 'rename', pane, seat.name),
        do: { do: 'rename', seat: seat.name, label: seat.label, seconds: profile.idleTimeout, rules, pane: seat.pane },
      });
    }
    if (profile.rulesOption === null) {
      const said = takeNotice();
      steps.push({
        kind: 'run',
        argv: herdr(session, 'pane', 'send-text', pane, seat.rules),
        note: said
          ? `${said}; the rules, only at an empty idle prompt; re-read before Enter, then wait for working with empty input`
          : 'the rules, only at an empty idle prompt; re-read before Enter, then wait for working with empty input',
        do: {
          do: 'deliver',
          seat: seat.name,
          label: seat.label,
          cli: seat.cli,
          rules: seat.rules,
          seconds: profile.idleTimeout,
          pane: seat.pane,
          ...(said ? { notice: said } : {}),
        },
      });
    } else if (seat.stage === 'named') {
      const said = takeNotice();
      steps.push({
        kind: 'skip',
        text: `${seat.name}: named, and its rules went with the launch; marked ready`,
        ...(said ? { note: said } : {}),
        do: { do: 'ready', seat: seat.name, rules: 'option', ...(said ? { notice: said } : {}) },
      });
    }
  }

  if (input.watchAlive) return steps;
  const watchArguments = session === 'default' ? '' : ` --session ${shellQuote(session)}`;
  const watchLine = input.watchLine ?? `team watch${watchArguments}`;
  steps.push({
    kind: 'run',
    argv: herdr(session, 'workspace', 'create', '--cwd', input.root, '--label', 'watchdog', '--no-focus'),
    do: { do: 'create', label: 'watchdog', cwd: input.root },
  });
  steps.push({
    kind: 'run',
    argv: herdr(session, 'pane', 'run', paneOf('watchdog'), watchLine),
    note: 'a desktop notification follows when the watch exits',
    do: { do: 'watch', label: 'watchdog', command: watchLine },
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
  /** The owner is closing workspaces that are not free, without typing into them. */
  abandon?: boolean;
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
      if (input.abandon) {
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'close', seat.workspace),
          note: 'abandoned: nothing was typed',
          do: { do: 'close', seat: seat.name, workspace: seat.workspace },
        });
        continue;
      }
      if (seat.cli === 'unknown') {
        steps.push({
          kind: 'skip',
          text:
            `${seat.name}: the state doesn't say which CLI it runs, so it can't be asked to exit; ` +
            'left running (`team down --abandon` closes it without typing)',
        });
        left++;
        continue;
      }
      steps.push({
        kind: 'skip',
        text: `${seat.name}: no launch profile for \`${seat.cli}\` in this version; left running`,
      });
      left++;
      continue;
    }
    if (seat.state !== 'free') {
      if (input.abandon) {
        steps.push({
          kind: 'run',
          argv: herdr(session, 'workspace', 'close', seat.workspace),
          note: 'abandoned: nothing was typed',
          do: { do: 'close', seat: seat.name, workspace: seat.workspace },
        });
        continue;
      }
      steps.push({ kind: 'skip', text: `${seat.name}: ${LEFT[seat.state]}; left running` });
      left++;
      continue;
    }
    // The printed command is `pane run`. The live step types with `typeText` and `pressEnter`:
    // `/exit` has to go into the idle prompt, and the screen is read again before the Enter.
    steps.push({
      kind: 'run',
      argv: herdr(session, 'pane', 'run', seat.pane, profile.exit),
      do: { do: 'type', seat: seat.name, pane: seat.pane, text: profile.exit },
    });
    steps.push({
      kind: 'wait',
      text: `until ${seat.name}'s pane is back at its shell (${profile.exitTimeout} s at most); on a time-out it is left as it is`,
      do: { do: 'gone', seat: seat.name, pane: seat.pane, seconds: profile.exitTimeout },
    });
    steps.push({
      kind: 'run',
      argv: herdr(session, 'workspace', 'close', seat.workspace),
      do: { do: 'close', seat: seat.name, workspace: seat.workspace },
    });
  }

  if (input.watchPid !== null) {
    steps.push({
      kind: 'run',
      argv: ['kill', String(input.watchPid)],
      note: 'the watch',
      do: { do: 'kill', pid: input.watchPid },
    });
  }

  if (session === 'default') {
    steps.push({ kind: 'skip', text: "session default: herdr's default session is never stopped" });
  } else if (left > 0) {
    steps.push({
      kind: 'skip',
      text: `session ${session}: not stopped, ${left} agent${left === 1 ? '' : 's'} left in it`,
    });
  } else {
    steps.push({
      kind: 'run',
      argv: ['herdr', 'session', 'stop', session],
      note: 'stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning',
      do: { do: 'stop', session },
    });
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
    if (step.kind === 'wait') return `  wait ${step.text}${step.note ? `\n    (${step.note})` : ''}`;
    return `  skip ${step.text}${step.note ? `\n    (${step.note})` : ''}`;
  });
  return `${lines.join('\n')}\ndry run: nothing was run\n`;
}
