import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTeamFile } from '../src/file/validate.ts';

const example = readFileSync(new URL('../examples/team.yaml', import.meta.url), 'utf8');

const result = validateTeamFile(example);
if (!result.ok) throw new Error(`examples/team.yaml is refused: ${JSON.stringify(result.errors)}`);
const { team, warnings } = result;

describe('the fictional example file', () => {
  test('is accepted without warnings', () => {
    expect(warnings).toEqual([]);
    expect(team.project).toBe('beacon');
    expect(team.session).toBe('beacon');
    expect(team.coordinator).toBe('claude-keeper');
    expect(team.operator).toBe('claude-signal');
  });

  test('every seat is there, count expanded', () => {
    expect(team.seats.map((seat) => seat.name)).toEqual([
      'claude-keeper',
      'claude-signal',
      'codex-beacon',
      'cursor-beacon',
      'nimbus-beacon',
      'nimbus-beacon-2',
      'nimbus-beacon-3',
    ]);
  });

  test('labels are numbered with the names under count', () => {
    expect(team.seats.filter((seat) => seat.declared === 'nimbus-beacon').map((seat) => seat.label)).toEqual([
      'nimbus',
      'nimbus-2',
      'nimbus-3',
    ]);
    expect(team.seats[0]).toMatchObject({ label: 'coordinator', declared: 'claude-keeper', count: 1, instance: 1 });
  });

  test('the machines gates and the useful shapes are the ones it shows', () => {
    expect(team.machine).toMatchObject({ loadStart: 2, loadMax: 8, memoryStart: 30, memoryMin: 10, diskMin: 20e9 });
    expect(team.seats.find((seat) => seat.name === 'codex-beacon')).toMatchObject({
      cli: 'codex',
      model: 'GPT Comet',
      version: '3',
      display: 'GPT-3 Comet',
      parked: true,
    });
    expect(team.seats.find((seat) => seat.name === 'cursor-beacon')).toMatchObject({
      cli: 'cursor',
      launch: 'cursor-agent',
    });
    expect(team.seats.find((seat) => seat.name === 'nimbus-beacon')).toMatchObject({
      cli: 'claude-code',
      vendor: 'nimbus',
      launch: 'nimbus-claude',
    });
  });
});
