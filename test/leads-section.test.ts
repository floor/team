import { describe, expect, test } from 'bun:test';
import { OWNER_SECTIONS, compare, describe as describeDifference, fingerprints } from '../src/approve/fingerprint.ts';
import { SECTIONS } from '../src/file/sections/index.ts';
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

const both = 'leads:\n  abandon: [coordinator, operator]\n';

describe('the leads section', () => {
  test('absent reads as null, present as the seats in the order the file lists them', () => {
    expect(team().leads).toBeNull();
    expect(team(both).leads).toEqual({ abandon: ['coordinator', 'operator'] });
    expect(team('leads:\n  abandon: [operator]\n').leads).toEqual({ abandon: ['operator'] });
    expect(team('leads:\n  abandon:\n    - operator\n    - coordinator\n').leads).toEqual({ abandon: ['operator', 'coordinator'] });
  });

  test('present it is a map with exactly abandon: required, no other key, no other shape', () => {
    expect(problems('leads: {}\n').join('\n')).toContain('leads: abandon is required');
    expect(problems('leads:\n').join('\n')).toContain('leads: abandon is required');
    expect(problems('leads:\n  seats: [coordinator]\n').join('\n')).toContain('unknown field "seats" in leads');
    expect(problems('leads: coordinator\n').join('\n')).toContain('leads must be a map with abandon');
    expect(problems('leads:\n  abandon: coordinator\n').join('\n')).toContain(
      'leads: abandon must be a list of coordinator, operator or both',
    );
  });

  test('the list is non-empty, of distinct coordinator or operator, case kept and exact', () => {
    for (const bad of ['[]', '[mascot]', '[Coordinator]', '[owner]', '[coordinator, coordinator]', '[""]', '[1]']) {
      expect(problems(`leads:\n  abandon: ${bad}\n`).join('\n')).toContain(
        'leads: abandon must name coordinator, operator or both',
      );
    }
    expect(problems('leads:\n  abandon:\n').join('\n')).toContain(
      'leads: abandon must name coordinator, operator or both',
    );
  });

  test('it is an owner section, placed directly before `delegates`, and the digest reads it there', () => {
    expect(OWNER_SECTIONS.indexOf('leads')).toBe(OWNER_SECTIONS.indexOf('delegates') - 1);
    expect(SECTIONS.findIndex((section) => section.name === 'leads')).toBe(
      SECTIONS.findIndex((section) => section.name === 'delegates') - 1,
    );
    expect(OWNER_SECTIONS).toContain('leads');
    expect(Object.keys(fingerprints(team(both)).sections).indexOf('leads')).toBe(
      Object.keys(fingerprints(team(both)).sections).indexOf('delegates') - 1,
    );
  });

  test('the fingerprint is null when absent, and every change to it differs', () => {
    const absent = fingerprints(team());
    const present = fingerprints(team(both));
    expect(present.sections.leads).not.toBe(absent.sections.leads);
    expect(fingerprints(team('leads:\n  abandon: [coordinator]\n')).sections.leads).not.toBe(present.sections.leads);
    expect(fingerprints(team('leads:\n  abandon: [operator, coordinator]\n')).sections.leads).not.toBe(
      present.sections.leads,
    );
    expect(compare(absent, present)).toEqual([{ kind: 'section', name: 'leads' }]);
    expect(describeDifference({ kind: 'section', name: 'leads' })).toBe('`leads` changed');
  });

  test('the key is `leads` only, and a second one is a duplicate key', () => {
    expect(problems(`lead:\n  abandon: [coordinator]\n`).join('\n')).toContain('unknown field "lead" in the file');
    expect(problems(`${both}${both}`).join('\n')).toContain('duplicate key "leads"');
  });
});
