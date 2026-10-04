// A fake CLI screen module implementing ScreenProfile for tests.
import type { ComposerReading, ScreenProfile } from '../../../src/watch/screen-profile.ts';

export const callOrder: string[] = [];

export function resetCalls(): void {
  callOrder.length = 0;
}

export const profile: ScreenProfile = {
  unknown(lines: string[]) {
    callOrder.push('unknown');
    return lines.some((l) => l.includes('HATCH_UNKNOWN'));
  },
  trust(lines: string[]) {
    callOrder.push('trust');
    return lines.some((l) => l.includes('HATCH_TRUST'));
  },
  permission(lines: string[]) {
    callOrder.push('permission');
    return lines.some((l) => l.includes('HATCH_PERMISSION') || l.includes('1. Proceed'));
  },
  question(lines: string[]) {
    callOrder.push('question');
    return lines.some((l) => l.includes('HATCH_QUESTION'));
  },
  working(lines: string[]) {
    callOrder.push('working');
    return lines.some((l) => l.includes('HATCH_WORKING'));
  },
  composer(lines: string[]): ComposerReading {
    callOrder.push('composer');
    // Attempts to return idle even under dialogs
    return { kind: 'idle' };
  },
};

export default profile;
