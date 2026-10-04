// A stand-in seat for `bun run e2e`: it draws one of the screens the real commands classify,
// logs every byte it receives, and leaves when its exit line is sent and entered. It runs no
// model and reaches no network, so the real commands can be exercised against a pane that looks
// and answers like a Claude Code seat. Launched as `exec -a claude …`, herdr sees the argv0 its
// profile matches.
//
//   bun scripts/fake-seat.ts <idle|unsent|permission> <log-file>
import { appendFileSync, writeFileSync } from 'node:fs';

export type FakeMode = 'idle' | 'unsent' | 'permission';

const RULE = '─'.repeat(60);
// The status line `seatModel` reads: "… · Opus 5.5 · …". The e2e's seats declare that model.
const STATUS = '  main · … · Opus 5.5 · S: $0.0 · W: 0%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';

/** The screen this mode draws, in the shapes `src/watch/screen.ts` classifies. */
export function screenFor(mode: FakeMode): string {
  if (mode === 'unsent') return `● Done.\n\n${RULE}\n❯ a line that was never sent\n${RULE}\n${STATUS}\n`;
  if (mode === 'permission') {
    return 'Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n';
  }
  return `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
}

/** The typed line a seat leaves on. The exit is the text and the Enter, never the text alone. */
export function isExit(bytes: string): boolean {
  return bytes.includes('/exit\r') || bytes.includes('/exit\n');
}

function main(): void {
  const [mode = 'idle', log = 'fake-seat.log'] = process.argv.slice(2);
  writeFileSync(log, '');
  process.stdout.write(`\x1b[2J\x1b[H${screenFor(mode as FakeMode)}`);
  // Raw: the pane never echoes what is typed at it, and every chunk arrives here whole.
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let seen = '';
  process.stdin.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    appendFileSync(log, `${JSON.stringify(text)}\n`);
    seen += text;
    if (isExit(seen)) process.exit(0);
  });
  // Nothing to do until it is sent: the exit line is the only way out.
  setInterval(() => {}, 1 << 30);
}

if (import.meta.main) main();
