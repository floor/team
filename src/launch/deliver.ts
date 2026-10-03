import { readScreen } from '../watch/screen.ts';
import { codexComposer } from '../profiles/codex-screen.ts';
import { antigravityComposer } from '../profiles/antigravity-screen.ts';
import { cursorComposer } from '../profiles/cursor-screen.ts';

export interface Delivery {
  screen(): string | undefined;
  status(): string | null;
  type(text: string): boolean;
  enter(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A first message is accepted only after working is observed with the composer empty again. */
export async function deliverRules(cli: string, text: string, seconds: number, io: Delivery): Promise<boolean> {
  const free = () => ['idle', 'done'].includes(io.status() ?? '');
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
  // Re-read immediately before Enter; a dialog that appeared after the paste gets no key.
  if (!free() || readScreen(cli, io.screen()).kind !== 'unsent' || !io.enter()) return false;
  for (;;) {
    const status = io.status();
    const screen = io.screen();
    const lines = screen?.split('\n').map((line) => line.trimEnd()).slice(-20);
    const composer = cli === 'codex' && lines
      ? codexComposer(lines)
      : cli === 'antigravity' && lines
      ? antigravityComposer(lines)
      : cli === 'cursor' && lines
      ? cursorComposer(lines)
      : readScreen(cli, screen);
    if (status === 'working' && composer.kind === 'idle') return true;
    const kind = readScreen(cli, io.screen()).kind;
    if (kind === 'trust' || kind === 'permission' || kind === 'question' || io.now() >= deadline) return false;
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return false;
  }
}
