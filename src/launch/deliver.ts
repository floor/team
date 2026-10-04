import { reportedLiveAgent } from './agent.ts';
import { profileFor } from '../profiles/index.ts';
import { classifyComposer, readScreen } from '../watch/screen.ts';

export interface Delivery {
  screen(): string | undefined;
  status(): string | null;
  type(text: string): boolean;
  enter(): boolean;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(): string[] | null;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A first message is accepted only after working is observed with the composer empty again. */
export async function deliverRules(cli: string, text: string, seconds: number, io: Delivery): Promise<boolean | 'no-agent'> {
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(io.foreground(), names);
  const free = () => ['idle', 'done'].includes(io.status() ?? '');
  if (!live()) return 'no-agent';
  if (!free() || readScreen(cli, io.screen()).kind !== 'idle' || !io.type(text)) return false;
  const deadline = io.now() + seconds * 1000;
  // Terminal rendering can lag send-text. Never send Enter until the pasted text is visible.
  for (;;) {
    const kind = readScreen(cli, io.screen()).kind;
    if (!free()) return false;
    if (kind === 'unsent') break;
    if (kind !== 'idle' || io.now() >= deadline) return false;
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return false;
  }
  // Re-read immediately before Enter. The agent is asked again: it may have exited
  // since the paste, and a dialog that appeared gets no key.
  if (!live()) return 'no-agent';
  if (!free() || readScreen(cli, io.screen()).kind !== 'unsent' || !io.enter()) return false;
  for (;;) {
    const status = io.status();
    const screen = io.screen();
    const composer = screen === undefined ? { kind: 'unknown' as const } : classifyComposer(cli, screen.split('\n'));
    if (status === 'working' && composer.kind === 'idle') return true;
    const kind = readScreen(cli, io.screen()).kind;
    if (kind === 'trust' || kind === 'permission' || kind === 'question' || io.now() >= deadline) return false;
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return false;
  }
}
