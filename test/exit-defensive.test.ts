// The returns covered here run only when a later check disagrees with the one just completed.
// Each one is a separate process: the stand-in has to be in place before the command loads.
import { expect, test } from 'bun:test';

const rows: { id: string; code: number; needle: string }[] = [
  { id: 'add.not-restored', code: 1, needle: "couldn't put worker back" },
  { id: 'add.prepared', code: 2, needle: 'the prepared edit does not validate' },
  { id: 'add.locked', code: 2, needle: 'the locked edit does not validate' },
  { id: 'approve.revalidate', code: 2, needle: 'the file does not validate' },
  { id: 'approve.placed', code: 2, needle: "names the project's parent" },
];

for (const row of rows) {
  test(row.id, async () => {
    const proc = Bun.spawn(['bun', 'test/exit-defensive-run.ts', row.id], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(code, err || out).toBe(0);
    const parsed = JSON.parse(out) as { code: number; err: string; calls: number };
    expect(parsed.err, `calls ${parsed.calls}`).toContain(row.needle);
    expect(parsed.code).toBe(row.code);
  });
}
