import type { HerdrAgent, PaneProcesses } from '../herdr.ts';
import { refusalReport, type Refusal } from './deliver.ts';
import { profileFor } from '../profiles/profile.ts';
import { modelDiffers, seatModel, type Running } from '../status/statusline.ts';
import { launchedIdentity, seatProcessVerdict, type LaunchedIdentity } from './identity.ts';
import type { Step } from './plan.ts';

export type ScreenKind = 'idle' | 'working' | 'permission' | 'trust' | 'question' | 'unsent' | 'unknown';

/** What a live `up` or `down` can do, apart from deciding it. Tests stand in for all of it. */
export type Host = {
  startServer(session: string): boolean;
  sessionUp(session: string): boolean | null;
  /**
   * Run once after the first workspace is created. A string leaves this seat and every
   * later seat out: the lobby changed between the gate and the create.
   */
  confirmLobby?(): string | null;
  createWorkspace(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  paneRun(session: string, pane: string, command: string): boolean;
  typeLine(session: string, pane: string, text: string): boolean | 'no-agent';
  /** `false` is a delivery that stopped without a reading worth reporting (no host, or no live
   *  pane); a `Refusal` is one that stopped on a screen the report can name. `file` is the
   *  seat's rules delivery: the text the file holds, the file's path, the one line typed, and
   *  the seat's name — the writer builds its own path from the name, never from a path a
   *  caller hands it. */
  deliverRules?(
    session: string,
    pane: string,
    cli: string,
    file: { text: string; path: string; line: string; seat: string },
    seconds: number,
  ): Promise<boolean | 'no-agent' | Refusal>;
  renameAgent(session: string, pane: string, name: string): boolean;
  closeWorkspace(session: string, workspace: string): boolean;
  stopSession(session: string): boolean;
  /** Clears the session this run has just stopped. Present on `down` only: `up` never deletes. */
  deleteSession?(session: string): boolean;
  kill(pid: number): boolean;
  /** Pane ids herdr lists an agent in, or null when the list can't be read. */
  agentPanes(session: string): string[] | null;
  /** The session's agents as herdr lists them now; null when the list can't be read. The repair
   *  step reads it again, immediately before the close, to bind the seat to its pane. */
  agentList?(session: string): HerdrAgent[] | null;
  /** Pane ids in a workspace as herdr lists them now; null when the list can't be read. The repair
   *  step checks that the workspace holds only the seat's pane before closing it. */
  workspacePanes?(session: string, workspace: string): string[] | null;
  classify(session: string, pane: string, cli: string): ScreenKind;
  /** The pane's visible text, ANSI styling and all, or null when the pane can't be read. */
  paneText?(session: string, pane: string): string | null;
  /** Whether the pane's foreground program is back to its shell; null when herdr can't tell. */
  shellBack?(session: string, pane: string): boolean | null;
  /** The pane's process identity, read to record it for the seat; null when herdr can't tell. */
  processInfo?(session: string, pane: string): PaneProcesses | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Null when this seat may launch. A string is the reason it may not. */
  allow(seat: string): string | null;
  record(
    seat: string,
    patch: {
      stage: 'launched' | 'named' | 'ready';
      pane?: string;
      workspace?: string;
      rules?: 'option' | 'message';
      createdWorkspace?: boolean;
      launched?: LaunchedIdentity;
    },
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
  dropped: readonly string[];
};

type Place = { pane: string; workspace?: string };

/** Strips string sequences (OSC, DCS, APC, PM, SOS) and their payloads in one linear pass.
 *  OSC sequences terminate at BEL (\x07) or ST (7-bit ESC \ or 8-bit C1 \x9c).
 *  DCS, APC, PM and SOS sequences terminate only at ST (7-bit ESC \ or 8-bit C1 \x9c).
 *  An unterminated sequence drops everything to the end of the text. */
export function stripControlStrings(text: string): string {
  const slices: string[] = [];
  let plainStart = 0;
  // States: 0: PLAIN, 1: PLAIN_ESC, 2: IN_OSC, 3: IN_OSC_ESC, 4: IN_OTHER, 5: IN_OTHER_ESC
  let state = 0;
  let escCount = 0;

  // Invariant, both halves:
  // - No output character comes from inside a string sequence.
  // - No plain input character outside every sequence is missing from the scanner's output.
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    switch (state) {
      case 0: // PLAIN
        if (c === '\x1b') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 1;
          escCount = 1;
        } else if (c === '\x9d') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 2;
        } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
          if (i > plainStart) slices.push(text.slice(plainStart, i));
          state = 4;
        }
        break;
      case 1: // PLAIN_ESC
        if (c === ']') {
          state = 2;
          escCount = 0;
        } else if (c === 'P' || c === 'X' || c === '^' || c === '_') {
          state = 4;
          escCount = 0;
        } else if (c === '\x1b') {
          escCount++;
        } else if (c === '\x9d') {
          // Drop pending ESC: it was followed by a string opener and must not reach across the removed string.
          state = 2;
          escCount = 0;
        } else if (c === '\x90' || c === '\x98' || c === '\x9e' || c === '\x9f') {
          // Drop pending ESC: it was followed by a string opener and must not reach across the removed string.
          state = 4;
          escCount = 0;
        } else {
          slices.push('\x1b'.repeat(escCount));
          escCount = 0;
          plainStart = i;
          state = 0;
        }
        break;
      case 2: // IN_OSC
        if (c === '\x07' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          state = 3;
        }
        break;
      case 3: // IN_OSC_ESC
        if (c === '\\' || c === '\x07' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          // stay in 3 (IN_OSC_ESC)
        } else {
          state = 2;
        }
        break;
      case 4: // IN_OTHER
        if (c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          state = 5;
        }
        break;
      case 5: // IN_OTHER_ESC
        if (c === '\\' || c === '\x9c') {
          state = 0;
          plainStart = i + 1;
        } else if (c === '\x1b') {
          // stay in 5 (IN_OTHER_ESC)
        } else {
          state = 4;
        }
        break;
    }
  }

  if (state === 0) {
    if (plainStart === 0 && slices.length === 0) return text;
    if (plainStart < text.length) slices.push(text.slice(plainStart));
  } else if (state === 1) {
    slices.push('\x1b'.repeat(escCount));
  }
  return slices.join('');
}

/** Pane text as it is safe to show, each line cut to `limit` characters: every escape sequence
 *  is removed whole — a CSI's private parameters among them, and the payload of a string
 *  sequence (OSC, DCS, APC, PM, SOS), whichever introducer and terminator are mixed, 7-bit
 *  `ESC x` or its one-byte C1 form, `ESC \` or C1 ST, or BEL to close an OSC; one left
 *  unterminated goes to the end of the text — and every
 *  control character but the line break, carriage return, backspace, bell and escape among
 *  them. Pane text is the one text `team` says that it did not write itself: a carriage return
 *  in it would overwrite the report that carries it. */
export function plainPaneText(text: string, limit = 200): string {
  return stripControlStrings(
    text
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x9b[0-?]*[ -/]*[@-~]/g, ''),
  )
    .replace(/\x1b./g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .split('\n')
    .map((line) => (line.length > limit ? `${line.slice(0, limit)}…` : line))
    .join('\n');
}

/** Where the launch line's echo sits among the lines, or -1 when it is not there. A prompt may
 *  stand in front of the echo and the command may wrap after it, so only the command's first
 *  characters are looked for — never the program word alone, which the failure message below
 *  the echo often repeats. A marker too short to be sure of is not used. */
function echoIndex(lines: readonly string[], command: string): number {
  const head = (command.trim().split('\n')[0] ?? '').slice(0, 24).trimEnd();
  return head.length >= 8 ? lines.findLastIndex((line) => line.includes(head)) : -1;
}

/** The pane's last lines for a report: at most six, the newest kept, empty lines dropped,
 *  control characters and styling gone (`plainPaneText`). The launch line's own echo comes
 *  first when it is within reach: the last line holding the start of the command that was
 *  typed, when six lines or fewer follow it. A launch line that scrolled further up leaves
 *  only the newest six, with the failure among them. */
export function paneExcerpt(text: string | null, command: string, limit = 6): string {
  if (text === null) return '';
  const lines = plainPaneText(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return '';
  const echo = echoIndex(lines, command);
  const tail = Math.max(0, lines.length - limit);
  const start = echo >= tail ? echo : tail;
  return lines.slice(start).map((line) => `  | ${line}\n`).join('');
}

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
  let serverFailed = false;
  let watchFailed = false;
  let held = false;
  let abort = false;
  let lobbyChecked = false;
  let lobbyLeftOut: string | null = null;

  // The reading is what is logged: screen text may follow it on the terminal (`detail`), and
  // never reaches the log file.
  const finish = (seat: string, what: string, detail = '') => {
    if (logged.has(seat)) return;
    logged.add(seat);
    host.say(`${seat}: ${what}\n${detail}`);
    host.log(seat, what);
  };

  // A seat whose pane no longer held the process team launched is closed without input and
  // launched again; its one line says both, when it is ready. Any other end of that seat keeps
  // its own line, and the close is what the plan and the state already show.
  const relaunched = new Map<string, 'gone' | 'replaced'>();
  const finishReady = (seat: string) => {
    const verdict = relaunched.get(seat);
    if (verdict === 'gone') finish(seat, 'its pane held no CLI; closed without input and launched again');
    else if (verdict === 'replaced') finish(seat, 'its pane held a process team did not launch; closed without input and launched again');
    else finish(seat, 'ready');
  };
  // The identity read after the idle prompt, to carry into every later record of the seat.
  const identities = new Map<string, LaunchedIdentity>();

  // The display label may be shared. The seat's name is the only key; the watch has no seat.
  const place = (key: string, pane?: string, workspace?: string): Place | null => {
    const have = places.get(key);
    if (have) return have;
    if (!pane) return null;
    const made = { pane, workspace };
    places.set(key, made);
    return made;
  };

  for (const step of steps) {
    const op = step.do;
    const seat = op && 'seat' in op ? op.seat : undefined;
    if (abort) continue;
    if (seat && dropped.has(seat)) continue;

    if (step.kind === 'skip') {
      if (op?.do === 'ready' && op.seat) {
        if (op.notice) host.say(`${op.seat}: ${op.notice}\n`);
        host.record(op.seat, { stage: 'ready', rules: op.rules });
        finishReady(op.seat);
      } else if (op?.do === 'refuse') {
        finish(op.seat, `refused: ${op.why}`);
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
      case 'create': {
        if (lobbyLeftOut && op.seat) {
          dropped.add(op.seat);
          finish(op.seat, lobbyLeftOut);
          break;
        }
        if (op.seat && op.notice) host.say(`${op.seat}: ${op.notice}\n`);
        if (op.seat) {
          const why = host.allow(op.seat);
          if (why) {
            dropped.add(op.seat);
            finish(op.seat, why);
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
        places.set(op.seat ?? op.label, made);
        if (op.seat) {
          host.record(op.seat, { stage: 'launched', pane: made.pane, workspace: made.workspace, createdWorkspace: true });
          host.running(op.seat);
        }
        if (!lobbyChecked && host.confirmLobby) {
          lobbyChecked = true;
          const changed = host.confirmLobby();
          if (changed) {
            lobbyLeftOut = changed;
            if (op.seat) {
              dropped.add(op.seat);
              finish(op.seat, changed);
            }
          }
        }
        break;
      }
      case 'launch': {
        if (op.notice) host.say(`${op.seat}: ${op.notice}\n`);
        const why = host.allow(op.seat);
        if (why) {
          dropped.add(op.seat);
          finish(op.seat, why);
          break;
        }
        const here = place(op.seat, op.pane);
        if (!here || !host.paneRun(session, here.pane, op.command)) {
          dropped.add(op.seat);
          finish(op.seat, 'its launch command did not run; left at launched');
          break;
        }
        host.running(op.seat);
        break;
      }
      case 'idle': {
        if (op.notice) host.say(`${op.seat}: ${op.notice}\n`);
        const here = place(op.seat, op.pane, op.workspace);
        if (!here) {
          dropped.add(op.seat);
          finish(op.seat, 'has no pane to read; left at launched');
          break;
        }
        const startedAt = host.now();
        const deadline = startedAt + op.seconds * 1000;
        const pollMs = 2000;
        let outcome: 'idle' | 'permission' | 'trust' | 'question' | 'ended' | 'timeout' = 'timeout';
        let last: ScreenKind = 'unknown';
        let endedRead: string | null = null;
        let endedFor = 0;
        // The launch line was run a moment ago, and herdr can still report the pane's shell for
        // a poll or two after it. Captured on herdr 0.7.1 in a scratch pane: right after
        // `pane run node -e …`, `pane process-info` listed the pane's shell (`shell_pid` 11915)
        // beside the shell's own startup child, and 600 ms later listed the program alone; a
        // launch line whose relative path was missing listed the shell at once, and 400 ms later
        // still. A slow wrapper looks the same for longer: the reviewer's drew its CLI on the
        // fourth poll, so a stretch of one or two polls is not an end. The end is said only on
        // what was read: the shell's own process is the pane's foreground program for three
        // full polls on end — one reading starts the stretch and three more carry it past
        // `pollMs` three times, and a single reading, the verdict's mutation, can never reach it
        // — and the launch line's echo is still on the screen, so the line did run and a prompt
        // below it is the CLI's absence, not the line's. A pane read before the line arrived,
        // one whose echo scrolled away, or a herdr that can't say (no shell process info) is
        // waited out to the deadline: the end is never inferred from the screen's text.
        let shellBackSince: number | null = null;
        for (;;) {
          const kind = host.classify(session, here.pane, op.cli);
          last = kind;
          const back = host.shellBack?.(session, here.pane) ?? null;
          const at = host.now();
          if (kind === 'unknown' && back === true) {
            shellBackSince ??= at;
            if (at - shellBackSince >= 3 * pollMs) {
              const read = host.paneText?.(session, here.pane) ?? null;
              if (read !== null && echoIndex(plainPaneText(read).split('\n'), op.command) >= 0) {
                endedRead = read;
                endedFor = Math.round((at - shellBackSince) / 1000);
                outcome = 'ended';
                break;
              }
            }
          } else shellBackSince = null;
          if (kind === 'idle' || kind === 'permission' || kind === 'trust' || kind === 'question') {
            outcome = kind;
            break;
          }
          if (host.now() >= deadline) break;
          const before = host.now();
          await host.sleep(pollMs);
          if (host.now() <= before) break;
        }
        if (outcome === 'idle') {
          // After the idle wait, before the rename and the rules: the same "differs" the watch uses.
          // Unread is not a difference, and the seat continues. A different model is left unnamed.
          if (op.model !== undefined && op.version !== undefined) {
            const screen = host.paneText?.(session, here.pane) ?? null;
            const running = screen === null ? null : seatModel({ cli: op.cli, model: op.model }, screen);
            const declared = { model: op.model, version: op.version };
            if (modelDiffers(running, declared)) {
              dropped.add(op.seat);
              finish(op.seat, modelLeft(running, declared, op.cli));
              break;
            }
            if (!running) {
              const note = "its screen doesn't show a model this version knows; not checked";
              host.say(`${op.seat}: ${note}\n`);
              host.log(op.seat, note);
            }
          }
          // The seat's own process, read now that its idle prompt is on the screen: the pane's
          // shell and the pids in front of it that are not the shell. Nothing is recorded when
          // herdr can't tell: a seat without the record keeps today's behaviour.
          const identity = launchedIdentity(host.processInfo?.(session, here.pane) ?? null);
          if (identity) {
            identities.set(op.seat, identity);
            host.record(op.seat, {
              stage: 'launched',
              pane: here.pane,
              launched: identity,
              ...(here.workspace ? { workspace: here.workspace } : {}),
            });
          }
          break;
        }
        const workspace = here.workspace ?? places.get(op.seat)?.workspace;
        if (outcome === 'permission' || outcome === 'trust' || outcome === 'question') {
          // A trust question is closed with no key and no text. The same for a permission or a question.
          const reading = outcome === 'trust' ? 'trust question' : outcome;
          if (workspace && !host.closeWorkspace(session, workspace)) {
            // The close did not happen: nothing may claim it did, and the seat keeps its state
            // exactly as it is — a later `up` finds it where this run left it.
            held = true;
            dropped.add(op.seat);
            finish(op.seat, `${reading}; its workspace did not close; left as it is`);
            break;
          }
          host.drop(op.seat);
          dropped.add(op.seat);
          const why = `${reading}; its workspace was closed without ${outcome === 'trust' ? 'an answer' : 'input'} and the seat left out`;
          finish(op.seat, why);
          break;
        }
        dropped.add(op.seat);
        const read = endedRead ?? host.paneText?.(session, here.pane) ?? null;
        if (outcome === 'ended') {
          // The report says only what was read: the shell has been the pane's foreground
          // program for `endedFor` seconds and no CLI prompt is on the screen. The workspace is
          // left open; the seat stays at launched, and a later `up` resumes it — the same
          // reading covers a CLI that exited and one that never began.
          finish(
            op.seat,
            `its pane has been back at its shell for ${endedFor} s and shows no CLI prompt; left at launched`,
            `${paneExcerpt(read, op.command)}  run \`team up\` again to resume it\n`,
          );
          break;
        }
        const waited = Math.round((host.now() - startedAt) / 1000);
        finish(
          op.seat,
          `timed out after ${waited} s waiting for its idle prompt; the screen last read ${last}; left at launched`,
          `${paneExcerpt(read, op.command)}  run \`team up\` again to resume it\n`,
        );
        break;
      }
      case 'rename': {
        const here = place(op.seat, op.pane);
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
        host.record(op.seat, {
          stage: 'named',
          pane: here.pane,
          ...(here.workspace ? { workspace: here.workspace } : {}),
          ...(identities.has(op.seat) ? { launched: identities.get(op.seat) } : {}),
        });
        if (op.rules === 'option') {
          host.record(op.seat, {
            stage: 'ready',
            rules: 'option',
            pane: here.pane,
            ...(here.workspace ? { workspace: here.workspace } : {}),
            ...(identities.has(op.seat) ? { launched: identities.get(op.seat) } : {}),
          });
          finishReady(op.seat);
        }
        break;
      }
      case 'deliver': {
        if (op.notice) host.say(`${op.seat}: ${op.notice}\n`);
        const here = place(op.seat, op.pane);
        const file = { text: op.rules, path: op.path, line: op.line, seat: op.seat };
        const delivered = here ? await host.deliverRules?.(session, here.pane, op.cli, file, op.seconds) : false;
        if (delivered === 'no-agent') {
          dropped.add(op.seat);
          finish(op.seat, 'no live agent in its pane; its rules were not delivered');
          break;
        }
        if (typeof delivered === 'object') {
          // The specific reading goes into the log; a row of the screen itself is printed to
          // the terminal alone, stripped and cut, never logged.
          dropped.add(op.seat);
          if (delivered.row !== null) {
            host.say(`${op.seat}: first row of its box that is not the rules line: ${plainPaneText(delivered.row)}\n`);
          }
          finish(op.seat, refusalReport(delivered));
          break;
        }
        if (!here || !delivered) {
          dropped.add(op.seat);
          finish(op.seat, 'its rules were not delivered; left at named');
          break;
        }
        host.record(op.seat, {
          stage: 'ready',
          rules: 'message',
          pane: here.pane,
          ...(identities.has(op.seat) ? { launched: identities.get(op.seat) } : {}),
        });
        finishReady(op.seat);
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
        const typed = host.typeLine(session, op.pane, op.text);
        if (typed === 'no-agent') {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'no live agent in its pane; its exit was not typed');
          break;
        }
        if (!typed) {
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
      case 'repair': {
        // The pane holds a process team did not launch (or no CLI at all): the workspace is
        // closed with no key and no text sent into it, the seat's launch state is cleared, and
        // the steps after this one launch the seat fresh, exactly as for a seat never launched.
        //
        // The close is the one destructive thing here, and the plan's reading may be minutes
        // old. Read herdr again, with nothing between these reads and the close, and close
        // only what is provably still the seat's stale pane: herdr must name this seat on the
        // recorded pane, that pane's workspace must be the recorded one, the process reading
        // must still be gone or replaced against the record, and a replaced pane's screen must
        // not read working. Anything else: nothing closed, nothing launched for this seat, its
        // state left as it is, and the seat out of this run.
        const listed = host.agentList ? host.agentList(session)?.find((agent) => agent.name === op.seat) : null;
        if (!listed || listed.pane !== op.pane || listed.workspace !== op.workspace) {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'herdr no longer shows this seat on its recorded pane; nothing closed; run team status');
          break;
        }
        const panes = host.workspacePanes ? host.workspacePanes(session, op.workspace) : null;
        if (panes === null || panes.length === 0) {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'its pane could not be read; nothing closed');
          break;
        }
        if (panes.length !== 1 || panes[0] !== op.pane) {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'its workspace holds other panes; nothing closed (close its pane there, then run team up)');
          break;
        }
        const verdict = seatProcessVerdict(op.launched, host.processInfo?.(session, op.pane));
        if (verdict === 'same') {
          dropped.add(op.seat);
          finish(op.seat, "its pane is the seat's again; left as it is");
          break;
        }
        if (verdict === 'unknown') {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'its pane could not be read; nothing closed');
          break;
        }
        if (verdict === 'replaced') {
          const kind = host.classify(session, op.pane, op.cli);
          if (kind === 'unknown') {
            held = true;
            dropped.add(op.seat);
            finish(op.seat, 'its pane could not be read; nothing closed');
            break;
          }
          if (kind === 'working') {
            held = true;
            dropped.add(op.seat);
            finish(op.seat, `the process in its pane is working; nothing closed (stop it there, or run team remove ${op.seat})`);
            break;
          }
          if (kind === 'unsent') {
            held = true;
            dropped.add(op.seat);
            finish(op.seat, `the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${op.seat})`);
            break;
          }
        }
        if (!host.closeWorkspace(session, op.workspace)) {
          held = true;
          dropped.add(op.seat);
          finish(op.seat, 'its workspace did not close; left as it is');
          break;
        }
        host.drop(op.seat);
        relaunched.set(op.seat, verdict);
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
        if (!host.stopSession(op.session)) {
          host.say(`session ${op.session}: it did not stop\n`);
          break;
        }
        // Without a `deleteSession` the stop is the whole step. `down` goes one further and clears
        // the session it has itself just stopped; a clear that does not happen names the command.
        if (host.deleteSession === undefined) host.say(`session ${op.session}: stopped\n`);
        else if (host.deleteSession(op.session)) host.say(`session ${op.session}: stopped and cleared\n`);
        else {
          host.say(`session ${op.session}: stopped; it did not clear, run \`herdr session delete ${op.session}\`\n`);
        }
        break;
      }
      default:
        break;
    }
  }

  return { serverFailed, watchFailed, held, dropped: [...dropped] };
}

// The owner adds the CLI's model flag for the file's model, or corrects the file and approves it.
function modelLeft(running: Running, declared: { model: string; version: string }, cli: string): string {
  const profile = profileFor(cli);
  const flag = profile?.modelFlag(declared.model, declared.version) ?? { option: '--model', id: null };
  const id = flag.id ?? '<id>';
  return (
    `runs ${running.model} ${running.version}; the file says ${declared.model} ${declared.version}; ` +
    `left at launched, not named. Add ${flag.option} ${id} to its launch, or correct the file's model and version and run \`team approve\``
  );
}
