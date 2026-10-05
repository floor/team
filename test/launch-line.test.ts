// A launch line is read the way `team` has always split it — on whitespace — and its program and
// its relative paths are looked for where the line will run: the folder the seat starts in. A
// relative path that a hand run in the project root finds may resolve nowhere from the lobby, and
// that is the finding this check exists for. A line it cannot read is said to be unchecked, never
// refused.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  launchBinary,
  launchLineFinding,
  launchLineFindings,
  startFolder,
  type LineSources,
} from '../src/launch/line.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';

const TEAM = (launch: string, extra = '') => `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
  - ../worktrees/acme/*
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${launch}
${extra}`;

let base: string;
let root: string;
let home: string;
let lobby: string;

function team(launch: string, extra = ''): TeamFile {
  const result = validateTeamFile(TEAM(launch, extra));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function seat(launch: string, name = 'worker', extra = ''): Seat {
  const found = team(launch, extra).seats.find((item) => item.name === name);
  if (!found) throw new Error(`no seat ${name}`);
  return found;
}

const sources = (over: Partial<LineSources> = {}): LineSources => ({ onPath: () => true, home, ...over });
const file = (path: string, text = 'x\n'): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-line-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  lobby = join(base, 'worktrees', 'acme', '.lobby');
  mkdirSync(root, { recursive: true });
  mkdirSync(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the launch line check', () => {
  test('the program is the first word that is not an assignment', () => {
    expect(launchBinary('AGENT_UNATTENDED=1 claude --model x')).toBe('claude');
    expect(launchBinary('  team-deepseek  ')).toBe('team-deepseek');
    expect(launchBinary('')).toBeNull();
  });

  test('a seat that works in worktrees starts in the lobby; a shared one where the file says', () => {
    const one = team('claude --model claude-opus-5-5');
    expect(startFolder(one, one.seats[1] as Seat)).toBe('../worktrees/acme/.lobby');
    expect(startFolder(one, one.seats[0] as Seat)).toBe('.');
  });

  test('a launcher on the PATH is fine; one that is not is a finding', () => {
    expect(launchLineFinding(team('team-deepseek --key x'), seat('team-deepseek --key x'), root, sources())).toBeNull();
    const finding = launchLineFinding(
      team('team-deepseek'),
      seat('team-deepseek'),
      root,
      sources({ onPath: (binary) => binary !== 'team-deepseek' }),
    );
    expect(finding).toEqual({ level: 'miss', why: 'its launch line starts `team-deepseek`, which is not on the PATH' });
  });

  test("its profile's own binary is left to the install finding", () => {
    const text = team('claude --model claude-opus-5-5');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources({ onPath: () => false }))).toBeNull();
  });

  test("a seat's file that only the project root holds is a finding naming the lobby and the file", () => {
    file(join(base, 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh');
    const finding = launchLineFinding(text, text.seats[1] as Seat, root, sources());
    expect(finding).toEqual({
      level: 'miss',
      why:
        'its launch line runs `../tools/x.sh`, not found from its start folder ../worktrees/acme/.lobby; ' +
        `the same file is at \`${join(base, 'tools', 'x.sh')}\` from the project root — write that path`,
    });
  });

  test('the same line is fine for a seat that starts in the project root', () => {
    file(join(base, 'tools', 'x.sh'));
    const extra = `
  - role: implementer
    name: rooty
    label: rooty
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: zsh ../tools/x.sh
    mode: shared
`;
    const text = team('claude --model claude-opus-5-5', extra);
    const found = text.seats.find((item) => item.name === 'rooty');
    if (!found) throw new Error('no seat rooty');
    expect(startFolder(text, found)).toBe('.');
    expect(launchLineFinding(text, found, root, sources())).toBeNull();
  });

  test('the same line is fine when the file is there from the lobby too', () => {
    file(join(base, 'worktrees', 'acme', 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources())).toBeNull();
  });

  test('a relative path that resolves from neither place is the same finding without the file', () => {
    const text = team('zsh ./nowhere.sh');
    const finding = launchLineFinding(text, text.seats[1] as Seat, root, sources());
    expect(finding).toEqual({
      level: 'miss',
      why: 'its launch line runs `./nowhere.sh`, not found from its start folder ../worktrees/acme/.lobby',
    });
  });

  test('a ~/… that expands to a file is fine; one that does not is a finding', () => {
    file(join(home, 'bin', 'x.sh'));
    const good = team('zsh ~/bin/x.sh');
    expect(launchLineFinding(good, good.seats[1] as Seat, root, sources())).toBeNull();
    const bad = team('zsh ~/bin/missing.sh');
    expect(launchLineFinding(bad, bad.seats[1] as Seat, root, sources())).toEqual({
      level: 'miss',
      why: 'its launch line runs `~/bin/missing.sh`, not found from `~`',
    });
  });

  test('a program written as a path is looked for from the folder it would run in', () => {
    const missing = team('./run.sh');
    expect(launchLineFinding(missing, missing.seats[1] as Seat, root, sources())?.level).toBe('miss');
    file(join(lobby, 'run.sh'));
    const there = team('./run.sh');
    expect(launchLineFinding(there, there.seats[1] as Seat, root, sources())).toBeNull();
    const absolute = team('/nowhere/at/all');
    expect(launchLineFinding(absolute, absolute.seats[1] as Seat, root, sources())).toEqual({
      level: 'miss',
      why: 'its launch line starts `/nowhere/at/all`, which does not exist',
    });
  });

  test('an argument the check does not examine is left alone', () => {
    const text = team('claude --model claude-opus-5-5 --add-dir relative/dir');
    expect(launchLineFinding(text, text.seats[1] as Seat, root, sources())).toBeNull();
  });

  test('a line that quotes or substitutes text is not checked, and never refused', () => {
    for (const launch of ['claude --model x --append-system-prompt "be terse"', 'claude $(which claude)', "zsh 'x.sh'"]) {
      const text = team(launch);
      const finding = launchLineFinding(text, text.seats[1] as Seat, root, sources({ onPath: () => false }));
      expect(finding?.level).toBe('note');
      expect(finding?.why).toContain('not checked');
    }
  });

  test('the report names each seat it would start, and leaves the stopped ones out', () => {
    file(join(base, 'tools', 'x.sh'));
    const text = team('zsh ../tools/x.sh', '    stopped: true\n');
    const stopped = launchLineFinding(text, text.seats[1] as Seat, root, sources());
    expect(stopped?.level).toBe('miss');
    expect(launchLineFindings(text, root, sources()).length).toBe(0);
  });
});
