import { describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateTeamFile } from '../../src/file/validate.ts';
import {
  checkRulesFile, removeRulesFile, rulesDeliveryOf, rulesFileHash, rulesFilePath, rulesLine, typeablePath, writeRulesFile,
} from '../../src/launch/rules-file.ts';
import { rulesOf } from '../../src/launch/rules.ts';

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
      const path = rulesFilePath('acme-web', root, home, 'codex-acme');
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
    const { team, seat } = codexSeat();
    return { home, path: rulesFilePath(team.project, '/nowhere', home, seat.name), text: rulesOf(team, seat) };
  }

  test('the file is written 0600 and its folder 0700, whatever the umask leaves in', () => {
    const { home, path, text } = fresh();
    const umask = process.umask(0o022);
    try {
      expect(writeRulesFile(path, text).ok).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(umask);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the file holds exactly the approved rules text, byte for byte', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text);
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a rewrite lands whole and leaves no temporary file behind', () => {
    const { home, path, text } = fresh();
    try {
      writeRulesFile(path, text);
      writeRulesFile(path, `${text}\nOne more rule.\n`);
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
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(victim, path);
      expect(writeRulesFile(path, text)).toEqual({ ok: false, why: 'symlink' });
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
      mkdirSync(dirname(dirname(path)), { recursive: true });
      symlinkSync(elsewhere, dirname(path));
      expect(writeRulesFile(path, text)).toEqual({ ok: false, why: 'symlink' });
      expect(readdirSync(elsewhere)).toEqual([]);
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('checking the file', () => {
  test('a file with the approved text, 0600 and this user\'s, is ok; a different text is not', () => {
    const { home, path, text } = (() => {
      const made = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
      const { team, seat } = codexSeat();
      return { home: made, path: rulesFilePath(team.project, '/nowhere', made, seat.name), text: rulesOf(team, seat) };
    })();
    try {
      writeRulesFile(path, text);
      expect(checkRulesFile(path, text)).toEqual({ ok: true });
      expect(checkRulesFile(path, 'other rules')).toEqual({ ok: false, what: 'its rules file differs from the approved rules' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing file, a symlink, a folder, and a mode wider than 0600 are each their own finding', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-rules-home-'));
    try {
      const { team, seat } = codexSeat();
      const path = rulesFilePath(team.project, '/nowhere', home, seat.name);
      const text = rulesOf(team, seat);
      expect(checkRulesFile(path, text)).toEqual({ ok: false, what: 'its rules file is missing' });
      writeRulesFile(path, text);
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
