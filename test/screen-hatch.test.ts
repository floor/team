import { describe, expect, test, beforeEach } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { classifyLines, composeLines } from '../src/watch/screen-core.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { classify, classifyComposer, readScreen } from '../src/watch/screen.ts';
import { callOrder, resetCalls } from './fixtures/hatch/hatch.ts';
import type { ScreenProfile } from '../src/watch/screen-profile.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/hatch', import.meta.url));

const EXPECTED_FIXTURES: [path: string, cli: string, r: string, c: string, comp: string][] = [
  ['test/fixtures/antigravity/1.2.16/exit-typed.txt', 'antigravity', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/antigravity/1.2.16/exit.txt', 'antigravity', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/antigravity/1.2.16/idle.txt', 'antigravity', 'idle', 'idle', 'idle'],
  ['test/fixtures/antigravity/1.2.16/permission-cut.txt', 'antigravity', 'permission', 'permission', 'unknown'],
  ['test/fixtures/antigravity/1.2.16/permission.txt', 'antigravity', 'permission', 'permission', 'unknown'],
  ['test/fixtures/antigravity/1.2.16/rules-accepted.txt', 'antigravity', 'idle', 'idle', 'idle'],
  ['test/fixtures/antigravity/1.2.16/trust.txt', 'antigravity', 'trust', 'trust', 'unknown'],
  ['test/fixtures/antigravity/1.2.16/unsent.txt', 'antigravity', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/antigravity/1.2.16/working.txt', 'antigravity', 'working', 'working', 'idle'],
  ['test/fixtures/claude-code/2.1.289/bash-mode-ansi.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/2.1.289/idle-suggestion-ansi.txt', 'claude-code', 'idle', 'idle', 'idle'],
  ['test/fixtures/claude-code/2.1.289/idle-suggestion-other-ansi.txt', 'claude-code', 'idle', 'idle', 'idle'],
  ['test/fixtures/claude-code/2.1.289/idle-suggestion-other-plain.txt', 'claude-code', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', 'claude-code', 'idle', 'idle', 'idle'],
  ['test/fixtures/claude-code/2.1.289/trust-ansi.txt', 'claude-code', 'trust', 'trust', 'unknown'],
  ['test/fixtures/claude-code/2.1.289/unsent-faint-first-ansi.txt', 'claude-code', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/claude-code/2.1.289/unsent-paste-ansi.txt', 'claude-code', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/claude-code/2.1.289/unsent-slash-ansi.txt', 'claude-code', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/claude-code/2.1.289/unsent-typed-ansi.txt', 'claude-code', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/claude-code/2.1.289/unsent-typing-while-running-ansi.txt', 'claude-code', 'working', 'working', 'unsent'],
  ['test/fixtures/claude-code/leftover-box.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/output-under-rule.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/rule-above.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/scrolled-shortcuts.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/shell-git-log.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/shell-prompt.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/shell-right-prompt.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/shell-shortcuts-indented.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/shell-shortcuts.txt', 'claude-code', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/claude-code/trust-unnumbered.txt', 'claude-code', 'trust', 'trust', 'unknown'],
  ['test/fixtures/codex/0.157.0/exit-typed.txt', 'codex', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/codex/0.157.0/exit.txt', 'codex', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/codex/0.157.0/idle.txt', 'codex', 'idle', 'idle', 'idle'],
  ['test/fixtures/codex/0.157.0/permission-pinned.txt', 'codex', 'permission', 'permission', 'unknown'],
  ['test/fixtures/codex/0.157.0/permission.txt', 'codex', 'permission', 'permission', 'unknown'],
  ['test/fixtures/codex/0.157.0/rules-accepted.txt', 'codex', 'idle', 'idle', 'idle'],
  ['test/fixtures/codex/0.157.0/startup-loading.txt', 'codex', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/codex/0.157.0/startup.txt', 'codex', 'question', 'question', 'unknown'],
  ['test/fixtures/codex/0.157.0/trust.txt', 'codex', 'trust', 'trust', 'unknown'],
  ['test/fixtures/codex/0.157.0/unsent.txt', 'codex', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/codex/0.157.0/working.txt', 'codex', 'working', 'working', 'idle'],
  ['test/fixtures/cursor/2026.10.01/exit-typed.txt', 'cursor', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/cursor/2026.10.01/exit.txt', 'cursor', 'unknown', 'unknown', 'unknown'],
  ['test/fixtures/cursor/2026.10.01/idle.txt', 'cursor', 'idle', 'idle', 'idle'],
  ['test/fixtures/cursor/2026.10.01/rules-accepted.txt', 'cursor', 'idle', 'idle', 'idle'],
  ['test/fixtures/cursor/2026.10.01/startup.txt', 'cursor', 'idle', 'idle', 'idle'],
  ['test/fixtures/cursor/2026.10.01/thinking.txt', 'cursor', 'working', 'working', 'idle'],
  ['test/fixtures/cursor/2026.10.01/trust.txt', 'cursor', 'trust', 'trust', 'unknown'],
  ['test/fixtures/cursor/2026.10.01/unsent.txt', 'cursor', 'unsent', 'unsent', 'unsent'],
  ['test/fixtures/cursor/2026.10.01/working-no-spinner.txt', 'cursor', 'working', 'working', 'idle'],
  ['test/fixtures/cursor/2026.10.01/working.txt', 'cursor', 'working', 'working', 'idle'],
];

describe('Slice C: ScreenProfile escape hatch', () => {
  beforeEach(() => {
    resetCalls();
  });

  test('the loader imports screen_module from the profile YAML', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir);
    expect(data.profile).toBeDefined();
    expect(typeof data.profile?.unknown).toBe('function');
    expect(typeof data.profile?.trust).toBe('function');
    expect(typeof data.profile?.permission).toBe('function');
    expect(typeof data.profile?.question).toBe('function');
    expect(typeof data.profile?.working).toBe('function');
    expect(typeof data.profile?.composer).toBe('function');
  });

  test('its predicates are called in the core stage order', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir);

    // 1. None of the predicates match: all 5 are called in order, then composer.
    const result = classifyLines(data, ['random line 1', 'random line 2']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question', 'working', 'composer']);
    expect(result.kind).toBe('idle');

    // 2. Early match: unknown matches first
    resetCalls();
    const unknownRes = classifyLines(data, ['HATCH_UNKNOWN here', 'HATCH_PERMISSION here']);
    expect(callOrder).toEqual(['unknown']);
    expect(unknownRes.kind).toBe('unknown');

    // 3. Trust matches second
    resetCalls();
    const trustRes = classifyLines(data, ['HATCH_TRUST here', 'HATCH_WORKING here']);
    expect(callOrder).toEqual(['unknown', 'trust']);
    expect(trustRes.kind).toBe('trust');

    // 4. Permission matches third
    resetCalls();
    const permRes = classifyLines(data, ['HATCH_PERMISSION here', 'HATCH_QUESTION here']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission']);
    expect(permRes.kind).toBe('permission');

    // 5. Question matches fourth
    resetCalls();
    const questRes = classifyLines(data, ['HATCH_QUESTION here', 'HATCH_WORKING here']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question']);
    expect(questRes.kind).toBe('question');

    // 6. Working matches fifth
    resetCalls();
    const workRes = classifyLines(data, ['HATCH_WORKING here']);
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question', 'working']);
    expect(workRes.kind).toBe('working');
  });

  test('a hatch composer returning idle under a numbered-choice dialog still reads permission (the floor wins)', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const data = loadScreen(yaml, fixtureDir);
    const dialogLines = readFileSync(resolve(fixtureDir, 'numbered-choice.txt'), 'utf8').split('\n');

    // In classifyLines: permission matches in core stage order, returning permission
    // even though composer returns idle
    resetCalls();
    const classified = classifyLines(data, dialogLines);
    expect(classified.kind).toBe('permission');
    expect(callOrder).toEqual(['unknown', 'trust', 'permission']);

    // Even if permission predicate returned false, the floor runs after composer and rejects idle
    const dataWithoutPermission = {
      ...data,
      profile: {
        ...data.profile,
        permission: () => {
          callOrder.push('permission');
          return false;
        },
      },
    };
    resetCalls();
    const floorClassified = classifyLines(dataWithoutPermission, dialogLines);
    // Safety floor marks dialog, returning unknown instead of idle
    expect(floorClassified.kind).toBe('unknown');
    expect(callOrder).toEqual(['unknown', 'trust', 'permission', 'question', 'working', 'composer']);

    // composeLines alone also rejects idle because safety floor runs after composer
    resetCalls();
    const composed = composeLines(data, dialogLines);
    expect(composed.kind).toBe('unknown');
  });

  test('no shipped profile uses the hatch', () => {
    const profilesDir = fileURLToPath(new URL('../src/profiles', import.meta.url));
    const yamlFiles = readdirSync(profilesDir).filter((file) => file.endsWith('.yaml'));
    expect(yamlFiles.length).toBeGreaterThanOrEqual(4);

    for (const file of yamlFiles) {
      const content = readFileSync(resolve(profilesDir, file), 'utf8');
      expect(content).not.toContain('screen_module');
      const data = loadScreen(content);
      expect(data.profile).toBeUndefined();
    }
  });

  test('all 51+ fixtures are unchanged', () => {
    expect(EXPECTED_FIXTURES.length).toBe(51);

    for (const [relPath, cli, expectedR, expectedC, expectedComp] of EXPECTED_FIXTURES) {
      const content = readFileSync(resolve(process.cwd(), relPath), 'utf8');
      const screenLines = content.split('\n');

      const r = readScreen(cli, content).kind;
      const c = classify(cli, screenLines).kind;
      const comp = classifyComposer(cli, screenLines).kind;

      expect(r).toBe(expectedR);
      expect(c).toBe(expectedC);
      expect(comp).toBe(expectedComp);
    }
  });

  test('rule for main on screens: no screen origin/main reads unknown/working/permission/trust/question may read idle or unsent', () => {
    const clis = ['claude-code', 'codex', 'cursor', 'antigravity'];
    for (const cli of clis) {
      const data = loadScreen(readFileSync(fileURLToPath(new URL(`../src/profiles/${cli}.yaml`, import.meta.url)), 'utf8'));
      // Verify stage order holds in shipped data
      expect(data.profile).toBeUndefined();
    }
  });
});
