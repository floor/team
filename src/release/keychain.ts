// The one credential seam of `team release check`: the Keychain lookup the Linear check is built
// on. The read is injected everywhere it matters — production wires the real facility through
// `realSecurityRun`, and no test ever runs it. The service name is the only argument the system
// tool ever sees; the key is taken from its standard output, is never echoed, is never an
// argument, an environment variable or input to any process, and reaches exactly one place: the
// Authorization header of the single Linear request (src/release/checks.ts).
import { spawn } from 'node:child_process';

export type KeyResult = { ok: true; key: string } | { ok: false; reason: string };

/** The key reader the command receives: a service name in, a key or a generic failure out. */
export type KeyReader = (service: string) => Promise<KeyResult>;

/** The system call itself, so a test can stand in for it without ever running it. */
export type SecurityRun = (service: string) => Promise<{ ok: true; stdout: string } | { ok: false }>;

/** The lookup's deadline: at expiry the lookup is terminated and reads unknown. */
export const KEYCHAIN_TIMEOUT_MS = 5000;

/** A bound on what the lookup may print before it is cut off: a key is a short ASCII string. */
const STDOUT_CAP = 4096;

/**
 * The Keychain read as the contract shapes it: the macOS facility only (no substitute store on
 * other platforms), only in an interactive run, and only when the command calls it — at most
 * once per command, after every non-secret prerequisite is known. The output's key is validated
 * before anything is built from it.
 */
export function keychainReader(platform: string, interactive: boolean, runSecurity: SecurityRun): KeyReader {
  return async (service) => {
    if (platform !== 'darwin') return { ok: false, reason: 'this platform has no such facility' };
    if (!interactive) return { ok: false, reason: 'the run is not interactive' };
    const out = await runSecurity(service);
    if (!out.ok) return { ok: false, reason: 'the lookup failed' };
    return keyOf(out.stdout);
  };
}

/** The production wiring of the one lookup, with its deadline. Never run by a test. */
export const realSecurityRun: SecurityRun = (service) =>
  new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const finish = (result: { ok: true; stdout: string } | { ok: false }) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const child = spawn('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const deadline = setTimeout(() => {
      child.kill();
      finish({ ok: false });
    }, KEYCHAIN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk;
      if (stdout.length > STDOUT_CAP) {
        child.kill();
        finish({ ok: false });
      }
    });
    child.on('error', () => finish({ ok: false }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout } : { ok: false }));
  });

/**
 * The key as the contract reads it: exactly one trailing line feed removed, then one or more
 * ASCII bytes 0x21 through 0x7e. Empty or any other output is a failure before any request is
 * formed. The output is never echoed into the failure.
 */
export function keyOf(stdout: string): KeyResult {
  const key = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (key.length === 0) return { ok: false, reason: 'the lookup printed nothing' };
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return { ok: false, reason: 'the lookup printed an illegal key' };
  }
  return { ok: true, key };
}
