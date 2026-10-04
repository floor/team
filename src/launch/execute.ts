import type { Step } from './plan.ts';

export type ScreenKind = 'idle' | 'working' | 'permission' | 'trust' | 'question' | 'unsent' | 'unknown';

/** What a live `up` or `down` can do, apart from deciding it. Tests stand in for all of it. */
export type Host = {
  startServer(session: string): boolean;
  sessionUp(session: string): boolean | null;
  /** Makes a folder and the parents it needs. Present on `up` and `add`, whose plans carry a lobby. */
  makeDir?(path: string): boolean;
  createWorkspace(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  paneRun(session: string, pane: string, command: string): boolean;
  typeLine(session: string, pane: string, text: string): boolean;
  deliverRules?(session: string, pane: string, cli: string, text: string, seconds: number): Promise<boolean>;
  renameAgent(session: string, pane: string, name: string): boolean;
  closeWorkspace(session: string, workspace: string): boolean;
  stopSession(session: string): boolean;
  kill(pid: number): boolean;
  /** Pane ids herdr lists an agent in, or null when the list can't be read. */
  agentPanes(session: string): string[] | null;
  classify(session: string, pane: string, cli: string): ScreenKind;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Null when this seat may launch. A string is the reason it may not. */
  allow(seat: string): string | null;
  record(
    seat: string,
    patch: { stage: 'launched' | 'named' | 'ready'; pane?: string; workspace?: string; rules?: 'option' | 'message' },
  ): void;
  /** The seat is really running, so the next seat's ceiling check counts it. */
  running(seat: string): void;
  drop(seat: string): void;
  say(line: string): void;
  log(who: string, what: string): void;
};

export type Report = {
  serverFailed: boolean;
  watchFailed: boolean;
  /** A seat or the watch was left behind, so the session must not be stopped. */
  held: boolean;
};

type Place = { pane: string; workspace?: string };

async function until(seconds: number, pace: number, host: Host, ready: () => boolean): Promise<boolean> {
  const deadline = host.now() + seconds * 1000;
  for (;;) {
    if (ready()) return true;
    if (host.now() >= deadline) return false;
    const before = host.now();
    await host.sleep(pace);
    // A clock that does not move would spin. Treat that as the wait running out.
    if (host.now() <= before) return false;
  }
}

/** Runs a plan. Steps carry the operation beside the command the dry run prints. */
export async function executePlan(steps: readonly Step[], session: string, host: Host): Promise<Report> {
  const places = new Map<string, Place>();
  const dropped = new Set<string>();
  const logged = new Set<string>();
  const failedDirs = new Set<string>();
  let serverFailed = false;
  let watchFailed = false;
  let held = false;
  let abort = false;

  const finish = (seat: string, what: string) => {
    if (logged.has(seat)) return;
    logged.add(seat);
    host.say(`${seat}: ${what}\n`);
    host.log(seat, what);
  };

  const place = (label: string, pane?: string, workspace?: string): Place | null => {
    const have = places.get(label);
    if (have) return have;
    if (!pane) return null;
    const made = { pane, workspace };
    places.set(label, made);
    return made;
  };

  for (const step of steps) {
    const op = step.do;
    const seat = op && 'seat' in op ? op.seat : undefined;
    if (abort) continue;
    if (seat && dropped.has(seat)) continue;

    if (step.kind === 'skip') {
      if (op?.do === 'ready' && op.seat) {
        host.record(op.seat, { stage: 'ready', rules: op.rules });
        finish(op.seat, 'ready');
      } else host.say(`  skip ${step.text}\n`);
      continue;
    }
    if (!op) continue;

    switch (op.do) {
      case 'server': {
        if (!host.startServer(op.session)) {
          serverFailed = true;
          abort = true;
          host.say(`session ${op.session}: its server did not start\n`);
        }
        break;
      }
      case 'wait-session': {
        const up = await until(op.seconds, 1000, host, () => host.sessionUp(op.session) === true);
        if (!up) {
          serverFailed = true;
          abort = true;
          host.say(`session ${op.session}: it was not running within ${op.seconds} s\n`);
        }
        break;
      }
      case 'lobby': {
        // A seat whose lobby folder could not be made is left out at its create step.
        if (!host.makeDir?.(op.path)) failedDirs.add(op.path);
        break;
      }
      case 'create': {
        if (op.seat) {
          const why = host.allow(op.seat);
          if (why) {
            dropped.add(op.seat);
            finish(op.seat, why);
            break;
          }
          if (failedDirs.has(op.cwd)) {
            dropped.add(op.seat);
            finish(op.seat, 'its lobby folder was not created; left out');
            break;
          }
          host.record(op.seat, { stage: 'launched' });
        }
        const made = host.createWorkspace(session, op.cwd, op.label);
        if (!made) {
          if (op.seat) {
            dropped.add(op.seat);
            finish(op.seat, 'its workspace was not created; left at launched');
          } else {
            watchFailed = true;
            host.say('watch: its workspace was not created\n');
            host.log('watch', 'its workspace was not created');
          }
          break;
        }
        places.set(op.label, made);
        if (op.seat) {
          host.record(op.seat, { stage: 'launched', pane: made.pane, workspace: made.workspace });
          host.running(op.seat);
        }
        break;
      }
      case 'launch': {
        const why = host.allow(op.seat);
        if (why) {
          dropped.add(op.seat);
          finish(op.seat, why);
          break;
        }
        const here = place(op.label, op.pane);
        if (!here || !host.paneRun(session, here.pane, op.command)) {
          dropped.add(op.seat);
          finish(op.seat, 'its launch command did not run; left at launched');
          break;
        }
        host.running(op.seat);
        break;
      }
      case 'idle': {
        const here = place(op.label, op.pane, op.workspace);
        if (!here) {
          dropped.add(op.seat);
          finish(op.seat, 'has no pane to read; left at launched');
          break;
        }
        const deadline = host.now() + op.seconds * 1000;
        let outcome: 'idle' | 'permission' | 'trust' | 'question' | 'timeout' = 'timeout';
        for (;;) {
          const kind = host.classify(session, here.pane, op.cli);
          if (kind === 'idle' || kind === 'permission' || kind === 'trust' || kind === 'question') {
            outcome = kind;
            break;
          }
          if (host.now() >= deadline) break;
          const before = host.now();
          await host.sleep(2000);
          if (host.now() <= before) break;
        }
        if (outcome === 'idle') break;
        const workspace = here.workspace ?? places.get(op.label)?.workspace;
        if (outcome === 'permission' || outcome === 'trust' || outcome === 'question') {
          // A trust question is closed with no key and no text. The same for a permission or a question.
          if (workspace) host.closeWorkspace(session, workspace);
          host.drop(op.seat);
          dropped.add(op.seat);
          const why =
            outcome === 'trust'
              ? 'left out: trust question'
              : `${outcome}; its workspace was closed without input and the seat left out`;
          finish(op.seat, why);
          break;
        }
        dropped.add(op.seat);
        finish(op.seat, 'timed out waiting for its idle prompt; left at launched');
        break;
      }
      case 'rename': {
        const here = place(op.label, op.pane);
        if (!here) {
          dropped.add(op.seat);
          finish(op.seat, 'has no pane to name; left at launched');
          break;
        }
        const seen = await until(
          op.seconds,
          2000,
          host,
          () => host.agentPanes(session)?.includes(here.pane) === true,
        );
        if (!seen || !host.renameAgent(session, here.pane, op.seat)) {
          dropped.add(op.seat);
          finish(op.seat, 'was not in the agent list in time; left at launched');
          break;
        }
        host.record(op.seat, { stage: 'named', pane: here.pane, workspace: here.workspace });
        if (op.rules === 'option') {
          host.record(op.seat, { stage: 'ready', rules: 'option', pane: here.pane, workspace: here.workspace });
          finish(op.seat, 'ready');
        }
        break;
      }
      case 'deliver': {
        const here = place(op.label, op.pane);
        if (!here || !await host.deliverRules?.(session, here.pane, op.cli, op.rules, op.seconds)) {
          dropped.add(op.seat);
          finish(op.seat, 'its rules were not delivered; left at named');
          break;
        }
        host.record(op.seat, { stage: 'ready', rules: 'message', pane: here.pane });
        finish(op.seat, 'ready');
        break;
      }
      case 'watch': {
        const here = places.get(op.label);
        if (!here || !host.paneRun(session, here.pane, op.command)) {
          watchFailed = true;
          host.say('watch: it did not start\n');
          host.log('watch', 'it did not start');
          break;
        }
        host.say('watch: started\n');
        host.log('watch', 'started');
        break;
      }
      case 'type': {
        if (!host.typeLine(session, op.pane, op.text)) {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'its exit was not typed; left as it is');
        }
        break;
      }
      case 'gone': {
        const gone = await until(
          op.seconds,
          2000,
          host,
          () => host.agentPanes(session)?.includes(op.pane) === false,
        );
        if (!gone) {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'timed out leaving its pane; left as it is');
        }
        break;
      }
      case 'close': {
        if (!host.closeWorkspace(session, op.workspace)) {
          held = true;
          finish(op.seat, 'its workspace did not close');
          break;
        }
        host.drop(op.seat);
        finish(op.seat, 'stopped');
        break;
      }
      case 'kill': {
        if (!host.kill(op.pid)) {
          held = true;
          host.say(`watch: pid ${op.pid} did not stop\n`);
        } else host.say('watch: stopped\n');
        break;
      }
      case 'stop': {
        if (held) {
          host.say(`session ${op.session}: not stopped, something was left in it\n`);
          break;
        }
        if (!host.stopSession(op.session)) host.say(`session ${op.session}: it did not stop\n`);
        else host.say(`session ${op.session}: stopped\n`);
        break;
      }
      default:
        break;
    }
  }

  return { serverFailed, watchFailed, held };
}
