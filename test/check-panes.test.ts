// The check's narrow live read (§3.3a) is per seat, not per pane id: an agent on a recorded pane
// whose name is not the seat the pane is recorded for buys no screen read — and a launched seat's
// pane is still read with no agent under its name, because that reading is what tells `gone` from
// `replaced`. The runs in test/check-panes-run.ts stand in a herdr that records every call and
// print the runs.
import { expect, test } from 'bun:test';
import { PANE_WINDOW } from '../src/herdr.ts';

type Ran = { code: number; err: string; out: string; calls: string[] };

test('the check reads a recorded pane only for the seat it is recorded for', async () => {
  const proc = Bun.spawn(['bun', 'test/check-panes-run.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const parsed = JSON.parse(out) as { one: Ran; two: Ran };

  // One: lead is recorded on %9 but never launched, and %9 is listed under `guest` — the seat is
  // missing, and %9 is a stranger's screen today: the record must buy no read of it at all.
  expect(parsed.one.err).toBe('');
  expect(parsed.one.code).toBe(1);
  expect(parsed.one.out).toContain('difference: lead is in the file and is not running\n');
  expect(parsed.one.out).toContain('difference: guest (%9) is running and is not in the file\n');
  expect(parsed.one.calls).toEqual(['sessionRunning acme-web', 'agentList acme-web', 'workspaceList acme-web']);

  // Two: the same pairing, launched — the pane still stands where the seat was launched, so it is
  // read, and the reading is what makes the difference: without it the verdict would be `unknown`
  // and the seat would read as `is in the file and is not running`.
  expect(parsed.two.err).toBe('');
  expect(parsed.two.code).toBe(1);
  expect(parsed.two.out).toContain(
    'difference: lead: the process in its pane is not the one team launched; nothing checks its model, account or rules\n',
  );
  expect(parsed.two.calls).toEqual([
    'sessionRunning acme-web',
    'agentList acme-web',
    'workspaceList acme-web',
    'paneProcesses %9 acme-web',
    `paneRead %9 ${PANE_WINDOW} acme-web`,
  ]);
});
