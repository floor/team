import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTeamFile } from '../src/file/validate.ts';

const example = readFileSync(new URL('../examples/floor-material.team.yaml', import.meta.url), 'utf8');

const result = validateTeamFile(example);
if (!result.ok) throw new Error(`examples/floor-material.team.yaml is refused: ${JSON.stringify(result.errors)}`);
const { team, warnings } = result;

describe('the converted floor-material example', () => {
  test('is accepted without warnings', () => {
    expect(warnings).toEqual([]);
    expect(team.project).toBe('material');
    expect(team.session).toBe('material');
    expect(team.coordinator).toBe('claude-operator');
  });

  test('every seat of the old file is there, count expanded', () => {
    expect(team.seats.map((seat) => seat.name)).toEqual([
      'claude-coordinator',
      'claude-operator',
      'claude-implementer',
      'claude-reviewer',
      'claude-reviewer-2',
      'claude-test-engineer',
      'claude-documentarist',
      'deepseek-material',
      'deepseek-material-2',
      'deepseek-material-3',
      'codex-material',
      'codex-astra-md3',
      'cursor-material',
      'grok-material',
      'gemini-material',
    ]);
  });

  test('labels come from the old workspaces, numbered with the names', () => {
    expect(team.seats.filter((seat) => seat.declared === 'deepseek-material').map((seat) => seat.label)).toEqual([
      'deepseek',
      'deepseek-2',
      'deepseek-3',
    ]);
    expect(team.seats[0]).toMatchObject({ label: 'coordinator', declared: 'claude-coordinator', count: 1, instance: 1 });
  });

  test('the model spellings of the old file are kept as displays', () => {
    expect(team.seats.find((seat) => seat.name === 'deepseek-material')).toMatchObject({
      cli: 'claude-code',
      vendor: 'deepseek',
      model: 'DeepSeek Flash',
      version: 'V4.1',
      display: 'DeepSeek V4.1 Flash',
      parked: false,
    });
    const displays = Object.fromEntries(team.seats.map((seat) => [seat.declared, seat.display]));
    expect(displays).toMatchObject({
      'codex-material': 'GPT-6 Sol',
      'codex-astra-md3': 'GPT-6 Astra',
      'cursor-material': 'Grok 4.7',
      'gemini-material': 'Gemini 3.1 Pro',
    });
  });
});
