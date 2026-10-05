import { describe, expect, test } from 'bun:test';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { formatDiff } from '../src/approve/diff.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { insideTrust } from '../src/file/paths.ts';

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

describe('dialogs', () => {
  test('omitted means owner, and only owner or coordinator is a value', () => {
    expect(team().dialogs).toEqual({ trust: 'owner' });
    expect(team('dialogs:\n  trust: owner\n').dialogs).toEqual({ trust: 'owner' });
    expect(team('dialogs:\n  trust: coordinator\n').dialogs).toEqual({ trust: 'coordinator' });
    expect(problems('dialogs:\n')).toContain('dialogs must be a map containing trust');
    expect(problems('dialogs:\n  permission: owner\n').join('\n')).toContain('unknown field "permission"');
    expect(problems('dialogs:\n  permission: owner\n').join('\n')).toContain('dialogs must contain trust');
    expect(problems('dialogs:\n  trust: someone\n').join('\n')).toContain('dialogs.trust must be one of: owner, coordinator');
    expect(problems('dialogs:\n  trust: 1\n').join('\n')).toContain('dialogs.trust must be one of: owner, coordinator');
    expect(problems('dialogs:\n  trust: owner\n  trust: coordinator\n').join('\n')).toContain('duplicate key "trust"');
  });

  test('the owner-section fingerprint changes with it, and the diff names the line', () => {
    const omitted = fingerprints(team());
    const owner = fingerprints(team('dialogs:\n  trust: owner\n'));
    const coordinator = fingerprints(team('dialogs:\n  trust: coordinator\n'));
    expect(omitted.sections.dialogs).toBe(owner.sections.dialogs);
    expect(coordinator.sections.dialogs).not.toBe(owner.sections.dialogs);
    const shown = formatDiff(minimal, `${minimal}dialogs:\n  trust: coordinator\n`).join('\n');
    expect(shown).toContain('dialogs:');
    expect(shown).toContain('trust: coordinator');
  });

  test('an absolute trust entry is not a prefix', () => {
    expect(insideTrust('srv/lobby', ['/srv/lobby'])).toBe(false);
  });
});
