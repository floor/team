import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { validateTeamFile } from '../../src/file/validate.ts';
import {
  checkRulesFile, removeRulesFile, rulesDeliveryOf, rulesFileHash, rulesFilePath, rulesLine, typeablePath, writeRulesFile,
} from '../../src/launch/rules-file.ts';
import { rulesOf } from '../../src/launch/rules.ts';

// The builder under test returns null for a name its rule refuses; every fixture's name passes.
function pathOf(project: string, root: string, home: string, seat: string): string {
  const path = rulesFilePath(project, root, home, seat);
  if (path === null) throw new Error(`the fixture seat name "${seat}" must be typeable`);
  return path;
}

const EXAMPLE = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');

function teamOf(text: string = EXAMPLE) {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(parsed.errors)}`);
  return parsed.team;
}

// The example's codex seat: a message seat, with rules to deliver.
function codexSeat() {
  const team = teamOf();
  const seat = team.seats.find((item) => item.cli === 'codex');
  if (!seat) throw new Error('the example fixture has no codex seat');
  return { team, seat };
}

describe('the line and its path', () => {
  test('a path of letters, digits and . _ / @ + - is typeable; anything else is not', () => {
    expect(typeablePath('/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md')).toBe(true);
    expect(typeablePath('/opt/team@v1.2/rules/a-b_c.md')).toBe(true);
    // A space, and a character outside the set: neither is quoted or escaped, both refused.
    expect(typeablePath('/home/owner/My Rules/implementer.md')).toBe(false);
    expect(typeablePath('/tmp/rules#1/implementer.md')).toBe(false);
    expect(typeablePath('/tmp/rules\t1/implementer.md')).toBe(false);
  });

  test('the line is the path, the hash, and the same words every time', () => {
    expect(rulesLine('/home/o/rules/a.md', '5e1d0a9c4b2f')).toBe(
      'Read /home/o/rules/a.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.',
    );
  });

  test('the hash is the first 12 hex digits of the text\'s SHA-256', () => {
    // printf 'Rules.' | shasum -a 256 | cut -c1-12
    expect(rulesFileHash('Rules.')).toBe('85372cb19aba');
    expect(rulesFileHash('Rules.')).toMatch(/^[0-9a-f]{12}$/);
  });

  test('the file lives in the project state folder, beside the approval store', () => {
    const root = mkdtempSync(join(tmpdir(), 'team-rules-file-'));
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      // The store folder is the approval store's own: `<home>/.config/team/<project>-<hash>`,
      // the project's state folder, with `rules/` and the seat's file inside it.
      const path = pathOf('acme-web', root, home, 'codex-acme');
      expect(path.startsWith(join(home, '.config', 'team'))).toBe(true);
      const parts = path.split('/');
      expect(parts.at(-2)).toBe('rules');
      expect(parts.at(-1)).toBe('codex-acme.md');
      expect(parts.at(-3)).toMatch(/^acme-web-[0-9a-f]+$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('writing the file', () => {
  function fresh() {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    // `~/.config` is the user's own configuration folder, never team's to make: the writer's
    // ladder starts at team's state root inside it.
    mkdirSync(join(home, '.config'), { recursive: true });
    const { team, seat } = codexSeat();
    return { home, path: pathOf(team.project, '/nowhere', home, seat.name), text: rulesOf(team, seat) };
  }

  // A ladder the writer accepts, for fixtures that plant something inside it: the store folder
  // and `rules/` exactly `0700` (mode 0700 has no bits a umask could clear).
  function mkLadder(path: string) {
    mkdirSync(dirname(dirname(dirname(path))), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(dirname(path)), { mode: 0o700 });
    mkdirSync(dirname(path), { mode: 0o700 });
  }

  test('the file is written 0600, and every folder of its ladder 0700, whatever the umask leaves in', () => {
    const { home, path, text } = fresh();
    const umask = process.umask(0o022);
    try {
      expect(writeRulesFile(path, text, rulesFileHash(text)).ok).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(dirname(path))).mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(dirname(dirname(path)))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(umask);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the file holds exactly the approved rules text, byte for byte', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text, rulesFileHash(text));
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a rewrite lands whole and leaves no temporary file behind', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text, rulesFileHash(text));
      writeRulesFile(path, `${text}\nOne more rule.\n`, rulesFileHash(`${text}\nOne more rule.\n`));
      expect(readFileSync(path, 'utf8')).toBe(`${text}\nOne more rule.\n`);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symbolic link at the file is refused, never written through', () => {
    const { home, path, text } = fresh();
    try {
      const victim = join(home, 'victim.md');
      writeFileSync(victim, 'do not touch\n');
      mkLadder(path);
      symlinkSync(victim, path);
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'place', what: 'a symbolic link' });
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(readlinkSync(path)).toBe(victim);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symbolic link at the rules folder is refused, nothing written through it', () => {
    const { home, path, text } = fresh();
    try {
      const elsewhere = mkdtempSync(join(tmpdir(), 'team-rules-elsewhere-'));
      mkdirSync(dirname(dirname(dirname(path))), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(dirname(path)), { mode: 0o700 });
      symlinkSync(elsewhere, dirname(path));
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'a symbolic link' });
      expect(readdirSync(elsewhere)).toEqual([]);
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a symbolic link at the project state folder is refused — the reviewers\' first probe', () => {
    const { home, path, text } = fresh();
    try {
      const elsewhere = mkdtempSync(join(tmpdir(), 'team-rules-elsewhere-'));
      mkdirSync(dirname(dirname(dirname(path))), { recursive: true, mode: 0o700 });
      symlinkSync(elsewhere, dirname(dirname(path)));
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'a symbolic link' });
      expect(readdirSync(elsewhere)).toEqual([]);
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a link pre-planted at the old process-id temporary name is ignored and untouched', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text, rulesFileHash(text));
      const victim = join(home, 'pid-victim.md');
      writeFileSync(victim, 'do not touch\n');
      const old = `${path}.${process.pid}.tmp`;
      symlinkSync(victim, old);
      expect(writeRulesFile(path, `${text}\nAgain.\n`, rulesFileHash(`${text}\nAgain.\n`)).ok).toBe(true);
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(readlinkSync(old)).toBe(victim);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([`${basename(path)}.${process.pid}.tmp`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a link pre-planted at the temporary\'s own name is refused by the exclusive no-follow open', () => {
    const { home, path, text } = fresh();
    try {
      const victim = join(home, 'temp-victim.md');
      writeFileSync(victim, 'do not touch\n');
      const planted = join(dirname(path), `${basename(path)}.planted.tmp`);
      mkLadder(path);
      symlinkSync(victim, planted);
      const written = writeRulesFile(path, text, rulesFileHash(text), () => 'planted');
      expect(written).toEqual({ ok: false, why: 'not-written' });
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      expect(readlinkSync(planted)).toBe(victim);
      expect(() => lstatSync(path)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a wider mode at the final name is refused, not replaced or chmod\'d — the reviewers\' second probe', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text, rulesFileHash(text));
      chmodSync(path, 0o644);
      expect(writeRulesFile(path, `${text}\nNo.\n`, rulesFileHash(`${text}\nNo.\n`))).toEqual({
        ok: false, why: 'place', what: 'mode 0644, not 0600',
      });
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a FIFO and a directory at the final name are each refused and left alone', () => {
    const { home, path, text } = fresh();
    try {
      mkLadder(path);
      execFileSync('mkfifo', [path]);
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'place', what: 'a FIFO' });
      expect(lstatSync(path).isFIFO()).toBe(true);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      rmSync(path);
      mkdirSync(path);
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'place', what: 'a directory' });
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a folder of the ladder team made, wider than 0700, is refused and never chmod\'d', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text, rulesFileHash(text));
      chmodSync(dirname(path), 0o755);
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'mode 0755, not 0700' });
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o755);
      chmodSync(dirname(path), 0o700);
      chmodSync(dirname(dirname(path)), 0o755);
      expect(writeRulesFile(path, text, rulesFileHash(text))).toEqual({ ok: false, why: 'folder', what: 'mode 0755, not 0700' });
      expect(lstatSync(dirname(dirname(path))).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a written file that does not read back as the line\'s hash is a changed refusal', () => {
    const { home, path, text } = fresh();
    try {
      // The hash the line would carry is of another text: the write lands, the read-back
      // refuses it, and nothing would be typed.
      expect(writeRulesFile(path, text, '000000000000')).toEqual({ ok: false, why: 'changed' });
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('checking the file', () => {
  test('a file with the approved text, 0600 and this user\'s, is ok; a different text is not', () => {
    const { home, path, text } = (() => {
      const made = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
      // The approval store always exists before a delivery: `~/.config` is there already.
      mkdirSync(join(made, '.config'), { recursive: true });
      const { team, seat } = codexSeat();
      return { home: made, path: pathOf(team.project, '/nowhere', made, seat.name), text: rulesOf(team, seat) };
    })();
    try {
      writeRulesFile(path, text, rulesFileHash(text));
      expect(checkRulesFile(path, text)).toEqual({ ok: true });
      expect(checkRulesFile(path, 'other rules')).toEqual({ ok: false, what: 'its rules file differs from the approved rules' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing file, a symlink, a folder, and a mode wider than 0600 are each their own finding', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    mkdirSync(join(home, '.config'), { recursive: true });
    try {
      const { team, seat } = codexSeat();
      const path = pathOf(team.project, '/nowhere', home, seat.name);
      const text = rulesOf(team, seat);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file is missing' });
      writeRulesFile(path, text, rulesFileHash(text));
      const victim = join(home, 'victim.md');
      writeFileSync(victim, text);
      const link = `${path}.link`;
      symlinkSync(victim, link);
      expect(checkRulesFile(link, text)).toEqual({ ok: false, what: 'its rules file is a symbolic link' });
      expect(checkRulesFile(dirname(path), text)).toEqual({ ok: false, what: 'its rules file is not a regular file' });
      chmodSync(path, 0o644);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file has mode 0644, not 0600' });
      chmodSync(path, 0o600);
      expect(checkRulesFile(path, text)).toEqual({ ok: true });
      removeRulesFile(path);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file is missing' });
      removeRulesFile(path); // a second removal of nothing is nothing
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the seat name where the path is built', () => {
  // The names the team file's own rule refuses — plus the one length that makes a file name over
  // 255 bytes — checked where the path is built, not only by the parser: a corrupt state entry
  // must never become a path. `codex/acme` and `../victim` are refused names; as raw strings they
  // are also the corrupt entries the removal test feeds.
  const refused = ['codex/acme', '..', '../victim', '.hidden', 'codex acme', 'a'.repeat(253)];

  test('a name the team file refuses, and a file name over 255 bytes, get no path at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      for (const name of refused) expect(rulesFilePath('acme-web', '/nowhere', home, name)).toBeNull();
      // 252 characters make a 255-byte file name exactly: the boundary itself passes.
      expect(rulesFilePath('acme-web', '/nowhere', home, 'a'.repeat(252))).toContain(`${'a'.repeat(252)}.md`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('each refused name is refused in the delivery too — nothing written, nothing typed', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team, seat } = codexSeat();
      for (const name of refused) {
        expect(rulesDeliveryOf(team, { ...seat, name }, '/nowhere', home)).toEqual({
          refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
        });
      }
      expect(existsSync(join(home, '.config'))).toBe(false); // nothing was written anywhere
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a corrupt state entry never turns a removal into an unlink elsewhere', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const store = join(home, '.config', 'team', 'acme-web-001471018cf6');
      mkdirSync(join(store, 'rules'), { recursive: true, mode: 0o700 });
      const victim = join(store, 'victim.md');
      writeFileSync(victim, 'do not touch\n');
      // The corrupt entries themselves: a `..` out of rules/ and a `/` into a folder of it.
      removeRulesFile(`${store}/rules/../victim.md`);
      removeRulesFile(`${store}/rules/codex/acme.md`);
      // And decoys planted at refused names inside rules/, plus no path at all. (The 253-character
      // name has no decoy: the file system itself refuses a 256-byte name, so nothing can be
      // planted there for a removal to find.)
      const planted = ['..', '.hidden', 'codex acme'];
      for (const name of planted) writeFileSync(join(store, 'rules', `${name}.md`), 'planted\n');
      for (const name of planted) removeRulesFile(join(store, 'rules', `${name}.md`));
      removeRulesFile(null);
      expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
      for (const name of planted) {
        expect(readFileSync(join(store, 'rules', `${name}.md`), 'utf8')).toBe('planted\n');
      }
      // A name that passes is still taken with its seat.
      const kept = join(store, 'rules', 'codex-acme.md');
      writeFileSync(kept, 'rules\n');
      removeRulesFile(kept);
      expect(existsSync(kept)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('one seat\'s delivery', () => {
  test('a message seat gets the file\'s text, path and line; an option seat gets no file', () => {
    const { team, seat } = codexSeat();
    const claude = team.seats.find((item) => item.cli === 'claude-code');
    if (!claude) throw new Error('the example fixture has no claude-code seat');
    const delivery = rulesDeliveryOf(team, seat, '/nowhere', '/home/owner');
    if ('refusal' in delivery) throw new Error(`unexpected refusal: ${delivery.refusal}`);
    expect(delivery.text).toBe(rulesOf(team, seat));
    expect(delivery.path.endsWith(join('rules', `${seat.name}.md`))).toBe(true);
    expect(delivery.line).toBe(rulesLine(delivery.path, rulesFileHash(delivery.text)));
    expect(rulesDeliveryOf(team, claude, '/nowhere', '/home/owner')).toEqual({ refusal: 'its rules travel as a launch option' });
  });

  test('a seat whose path can\'t be typed is refused before anything is written or typed', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team, seat } = codexSeat();
      const plain = rulesDeliveryOf(team, seat, '/nowhere', home);
      if ('refusal' in plain) throw new Error('the plain path must be typeable here');
      // A seat name with a space makes the path untypeable: nothing is quoted, nothing typed.
      const spaced = { ...seat, name: 'codex acme' };
      expect(rulesDeliveryOf(team, spaced, '/nowhere', home)).toEqual({
        refusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
