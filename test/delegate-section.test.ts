import { describe, expect, test } from 'bun:test';
import { compare, describe as describeDifference, fingerprints } from '../src/approve/fingerprint.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const minimal = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function team(extra = '') {
  const result = validateTeamFile(`${minimal}${extra}`);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function problems(extra: string): string[] {
  const result = validateTeamFile(`${minimal}${extra}`);
  return result.ok ? [] : result.errors.map((problem) => problem.message);
}

/** One `delegates` entry, indented under the key. */
const entry = (pane: string, commands: string) => `  - pane: ${pane}\n    commands: [${commands}]\n`;

const one = `delegates:\n${entry('main/w1:p1', 'up, down, add, remove, approve')}`;

describe('the delegates section', () => {
  test('absent reads as null, present as the panes and their ordered commands', () => {
    expect(team().delegates).toBeNull();
    expect(team(one).delegates).toEqual([
      { pane: 'main/w1:p1', commands: ['up', 'down', 'add', 'remove', 'approve'] },
    ]);
    expect(team(`delegates:\n${entry('main/w2:p1', 'add, remove')}${entry('Main/W1:P1', 'approve')}`).delegates).toEqual([
      { pane: 'main/w2:p1', commands: ['add', 'remove'] },
      { pane: 'Main/W1:P1', commands: ['approve'] },
    ]);
  });

  test('the list is non-empty, at most eight entries, and two entries naming one pane are refused', () => {
    expect(problems('delegates: []\n').join('\n')).toContain('delegates must name at least one pane');
    expect(problems('delegates:\n  pane: main/w1:p1\n').join('\n')).toContain(
      'delegates must be a list of panes and their commands',
    );
    const many = Array.from({ length: 9 }, (_, index) => entry(`main/w${index + 1}:p1`, 'up')).join('');
    expect(problems(`delegates:\n${many}`).join('\n')).toContain('delegates must name at most 8 panes');
    expect(problems(`delegates:\n${entry('main/w1:p1', 'up')}${entry('main/w1:p1', 'add')}`).join('\n')).toContain(
      'two delegates name the pane "main/w1:p1"',
    );
    expect(team(`delegates:\n${entry('main/w1:p1', 'up')}${entry('main/w2:p1', 'up')}`).delegates).toHaveLength(2);
  });

  test('an entry is a map with exactly pane and commands; `seat` and the rest are unknown keys', () => {
    expect(problems('delegates:\n  - up\n').join('\n')).toContain('a delegate must be a map with pane and commands');
    expect(problems('delegates:\n  - {}\n').join('\n')).toContain('a delegate must contain pane and commands');
    expect(problems(`delegates:\n  - pane: main/w1:p1\n`).join('\n')).toContain('a delegate: commands is required');
    expect(problems(`delegates:\n  - commands: [up]\n`).join('\n')).toContain('a delegate: pane is required');
    expect(problems(`delegates:\n${entry('main/w1:p1', 'up')}  - pane: main/w2:p1\n    commands: [up]\n    seat: lead\n`).join('\n')).toContain(
      'unknown field "seat" in a delegate',
    );
  });

  test('pane is one session, one slash, one pane id: case kept, whitespace and a second slash refused', () => {
    for (const pane of ['main', 'main/w1/p1', '/w1:p1', 'main/']) {
      const messages = problems(`delegates:\n${entry(`"${pane}"`, 'up')}`).join('\n');
      expect(messages).toContain('a delegate: pane must be <herdr session>/<pane id>');
    }
    for (const pane of ['main /w1:p1', 'main/ w1:p1', 'main/w1 p1']) {
      const messages = problems(`delegates:\n${entry(`"${pane}"`, 'up')}`).join('\n');
      expect(messages).toContain('a delegate: pane must not contain whitespace');
    }
  });

  test('a pane in the team\'s own session is refused at load', () => {
    expect(problems(`delegates:\n${entry('acme/w1:p1', 'up')}`).join('\n')).toContain(
      'names the team\'s own session "acme"',
    );
    expect(problems(`session: acme-web\ndelegates:\n${entry('acme-web/w1:p1', 'up')}`).join('\n')).toContain(
      'names the team\'s own session "acme-web"',
    );
    expect(team(`session: acme-web\ndelegates:\n${entry('acme/w1:p1', 'up')}`).delegates).toEqual([
      { pane: 'acme/w1:p1', commands: ['up'] },
    ]);
  });

  test('commands are a non-empty ordered list of distinct lower-case ones of the five', () => {
    expect(team(`delegates:\n${entry('main/w1:p1', 'down, up')}`).delegates).toEqual([
      { pane: 'main/w1:p1', commands: ['down', 'up'] },
    ]);
    expect(team(`delegates:\n${entry('main/w1:p1', 'approve')}`).delegates).toEqual([
      { pane: 'main/w1:p1', commands: ['approve'] },
    ]);
    for (const bad of ['[]', '[up, up]', '[Up]', '[trust]', '[answer]', '[Approve]', '[restart]', '[1]', '[up, ""]']) {
      expect(problems(`delegates:\n${entry('main/w1:p1', bad)}`).length).toBeGreaterThan(0);
    }
    expect(problems(`delegates:\n  - pane: main/w1:p1\n    commands: up\n`).join('\n')).toContain(
      'a delegate: commands must be a list of up, down, add, remove, approve',
    );
    expect(problems(`delegates:\n${entry('main/w1:p1', '[]')}`).join('\n')).toContain(
      'a delegate: commands must name at least one',
    );
    expect(problems(`delegates:\n${entry('main/w1:p1', 'up, up')}`).join('\n')).toContain(
      'a delegate: commands names "up" twice',
    );
    expect(problems(`delegates:\n${entry('main/w1:p1', 'Up')}`).join('\n')).toContain('"Up" is not one');
  });

  test('nothing smuggles a different delegate past the parser', () => {
    // Anchors and aliases are refused by the parser itself, so a section cannot be shared with,
    // or re-pointed at, another node in the file.
    expect(problems(`delegates: &d\n${entry('main/w1:p1', 'up')}`).join('\n')).toContain(
      'anchors ("&") are not supported',
    );
    expect(problems(`delegates: *d\n`).join('\n')).toContain('aliases ("*") are not supported');
    // A duplicate key anywhere — the section, or a field inside an entry — is refused.
    expect(problems(`${one}delegates:\n${entry('main/w2:p1', 'up')}`).join('\n')).toContain(
      'duplicate key "delegates"',
    );
    expect(problems(`delegates:\n  - pane: main/w1:p1\n    pane: main/w2:p1\n    commands: [up]\n`).join('\n')).toContain(
      'duplicate key "pane"',
    );
    // One document per file: a second document cannot hold a different section.
    expect(problems(`${one}---\nproject: other\n`).join('\n')).toContain(
      'document markers are not supported: one document per file',
    );
    // `commands` as a string is not a list of one.
    expect(problems(`delegates:\n  - pane: main/w1:p1\n    commands: up\n`).join('\n')).toContain(
      'a delegate: commands must be a list',
    );
    // The pane is compared exactly: `Main/W1:P1` is a different pane, so both load, and the
    // approval digest differs from the lower-case one.
    const lower = team(`delegates:\n${entry('main/w1:p1', 'up')}`);
    const cased = team(`delegates:\n${entry('main/w1:p1', 'up')}${entry('Main/W1:P1', 'up')}`);
    expect(cased.delegates).toEqual([
      { pane: 'main/w1:p1', commands: ['up'] },
      { pane: 'Main/W1:P1', commands: ['up'] },
    ]);
    expect(fingerprints(cased).sections.delegates).not.toBe(fingerprints(lower).sections.delegates);
  });

  test('the owner-section fingerprint is null when absent, and every change to it differs', () => {
    const absent = fingerprints(team());
    const present = fingerprints(team(one));
    expect(present.sections.delegates).not.toBe(absent.sections.delegates);
    expect(fingerprints(team(`delegates:\n${entry('main/w2:p1', 'up, down, add, remove, approve')}`)).sections.delegates).not.toBe(
      present.sections.delegates,
    );
    expect(fingerprints(team(`delegates:\n${entry('main/w1:p1', 'down, up, add, remove, approve')}`)).sections.delegates).not.toBe(
      present.sections.delegates,
    );
    expect(fingerprints(team(`delegates:\n${entry('main/w1:p1', 'up')}`)).sections.delegates).not.toBe(
      present.sections.delegates,
    );
    expect(compare(absent, present)).toEqual([{ kind: 'section', name: 'delegates' }]);
    expect(describeDifference({ kind: 'section', name: 'delegates' })).toBe('`delegates` changed');
  });
});
