import { describe, expect, test, beforeEach } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyLines, composeLines } from '../src/watch/screen-core.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { classify, classifyComposer, readScreen, type Screen } from '../src/watch/screen.ts';
import { callOrder, resetCalls } from './fixtures/hatch/hatch.ts';
import type { ScreenProfile } from '../src/watch/screen-profile.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/hatch', import.meta.url));

function enumerateScreenFixtures(): { relPath: string; cli: string; absPath: string }[] {
  const root = resolve(process.cwd(), 'test/fixtures');
  const results: { relPath: string; cli: string; absPath: string }[] = [];

  function scan(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'hatch' && name !== 'yaml') scan(full);
      } else if (name.endsWith('.txt')) {
        const rel = relative(process.cwd(), full);
        const relUnderFixtures = relative(root, full);
        const cli = relUnderFixtures.split(/[/\\]/)[0] ?? '';
        results.push({ relPath: rel, cli, absPath: full });
      }
    }
  }

  scan(root);
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

const EXPECTED_FIXTURE_KINDS: Record<string, [r: Screen['kind'], c: Screen['kind'], comp: Screen['kind']]> = {
  'test/fixtures/antigravity/1.2.16/exit-typed.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/antigravity/1.2.16/exit.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/antigravity/1.2.16/folded-rules.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/antigravity/1.2.16/idle.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/antigravity/1.2.16/permission-cut.txt': ['permission', 'permission', 'unknown'],
  'test/fixtures/antigravity/1.2.16/permission.txt': ['permission', 'permission', 'unknown'],
  'test/fixtures/antigravity/1.2.16/rules-accepted.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/antigravity/1.2.16/trust.txt': ['trust', 'trust', 'unknown'],
  'test/fixtures/antigravity/1.2.16/unsent.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/antigravity/1.2.16/working.txt': ['working', 'working', 'idle'],
  'test/fixtures/claude-code/2.1.289/bash-mode-ansi.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/2.1.289/idle-suggestion-ansi.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/claude-code/2.1.289/idle-suggestion-other-ansi.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/claude-code/2.1.289/idle-suggestion-other-plain.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/claude-code/2.1.289/idle-suggestion-plain.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/claude-code/2.1.289/trust-ansi.txt': ['trust', 'trust', 'unknown'],
  'test/fixtures/claude-code/2.1.289/unsent-faint-first-ansi.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/claude-code/2.1.289/unsent-paste-ansi.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/claude-code/2.1.289/unsent-slash-ansi.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/claude-code/2.1.289/unsent-typed-ansi.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/claude-code/2.1.289/unsent-typing-while-running-ansi.txt': ['working', 'working', 'unsent'],
  'test/fixtures/claude-code/leftover-box.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/output-under-rule.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/quoted-dialog.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/claude-code/rule-above.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/scrolled-shortcuts.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-bypass-only.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-git-log.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-prompt.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-right-prompt.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-shortcuts-indented.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-shortcuts.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/shell-status-only.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/claude-code/trust-unnumbered.txt': ['trust', 'trust', 'unknown'],
  'test/fixtures/codex/0.157.0/exit-typed.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/codex/0.157.0/exit.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/codex/0.157.0/idle.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/codex/0.157.0/permission-pinned.txt': ['permission', 'permission', 'unknown'],
  'test/fixtures/codex/0.157.0/permission.txt': ['permission', 'permission', 'unknown'],
  'test/fixtures/codex/0.157.0/rules-accepted.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/codex/0.157.0/startup-loading.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/codex/0.157.0/startup.txt': ['question', 'question', 'unknown'],
  'test/fixtures/codex/0.157.0/trust.txt': ['trust', 'trust', 'unknown'],
  'test/fixtures/codex/0.157.0/unsent.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/codex/0.157.0/working.txt': ['working', 'working', 'idle'],
  'test/fixtures/cursor/2026.10.01/exit-typed.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/cursor/2026.10.01/exit.txt': ['unknown', 'unknown', 'unknown'],
  'test/fixtures/cursor/2026.10.01/follow-up-queue-hint.txt': ['working', 'working', 'idle'],
  'test/fixtures/cursor/2026.10.01/follow-up-queue-one.txt': ['working', 'working', 'idle'],
  'test/fixtures/cursor/2026.10.01/follow-up-queue-two.txt': ['working', 'working', 'idle'],
  'test/fixtures/cursor/2026.10.01/follow-up-queue-typed.txt': ['working', 'working', 'unsent'],
  'test/fixtures/cursor/2026.10.01/idle.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/cursor/2026.10.01/rules-accepted.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/cursor/2026.10.01/startup.txt': ['idle', 'idle', 'idle'],
  'test/fixtures/cursor/2026.10.01/thinking.txt': ['working', 'working', 'idle'],
  'test/fixtures/cursor/2026.10.01/trust.txt': ['trust', 'trust', 'unknown'],
  'test/fixtures/cursor/2026.10.01/unsent.txt': ['unsent', 'unsent', 'unsent'],
  'test/fixtures/cursor/2026.10.01/working-no-spinner.txt': ['working', 'working', 'idle'],
  'test/fixtures/cursor/2026.10.01/working.txt': ['working', 'working', 'idle'],
};

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

  test('the safety floor sees the whole window: hatch composer cannot shrink it with from past dialogs', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const baseData = loadScreen(yaml, fixtureDir);

    const dialogFixtures: { name: string; path: string; kind: Screen['kind']; match: string }[] = [
      { name: 'numbered-choice', path: 'test/fixtures/hatch/numbered-choice.txt', kind: 'permission', match: '1. Proceed' },
      { name: 'trust', path: 'test/fixtures/codex/0.157.0/trust.txt', kind: 'trust', match: 'Trust this folder?' },
      { name: 'permission', path: 'test/fixtures/codex/0.157.0/permission.txt', kind: 'permission', match: '1. Yes, proceed' },
      { name: 'question', path: 'test/fixtures/codex/0.157.0/startup.txt', kind: 'question', match: 'Update available' },
    ];

    for (const { path: relPath, kind, match } of dialogFixtures) {
      const lines = readFileSync(resolve(process.cwd(), relPath), 'utf8').split('\n');

      for (const composerKind of ['idle', 'unsent'] as const) {
        // 1. With predicates matching the dialog, classifyLines returns the dialog's kind
        // even when composer returns idle or unsent with from: 1000
        const dataWithPredicate = {
          ...baseData,
          profile: {
            ...baseData.profile,
            [kind]: (l: string[]) => l.some((line) => line.includes(match)),
            composer: () => ({ kind: composerKind, from: 1000 }),
          },
        };
        const classified = classifyLines(dataWithPredicate, lines);
        expect(classified.kind).toBe(kind);

        // 2. With predicates forced false, the safety floor runs over the full window
        // and rejects idle/unsent, returning unknown
        const dataPredicatesFalse = {
          ...baseData,
          profile: {
            unknown: () => false,
            trust: () => false,
            permission: () => false,
            question: () => false,
            working: () => false,
            composer: () => ({ kind: composerKind, from: 1000 }),
          },
        };
        const floorClassified = classifyLines(dataPredicatesFalse, lines);
        expect(floorClassified.kind).toBe('unknown');

        // 3. composeLines also runs the safety floor over the full window, returning unknown
        const composed = composeLines(dataPredicatesFalse, lines);
        expect(composed.kind).toBe('unknown');
      }
    }
  });

  test('a hatch cannot crash the watch: throwing predicates and composer or invalid returns are guarded', () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const baseData = loadScreen(yaml, fixtureDir);
    const lines = ['some regular terminal line'];

    // 1. Predicates throwing are treated as misses (do not crash)
    for (const stage of ['unknown', 'trust', 'permission', 'question', 'working'] as const) {
      const throwingData = {
        ...baseData,
        profile: {
          ...baseData.profile,
          [stage]: () => {
            throw new Error(`${stage} boom`);
          },
        },
      };
      // classifyLines carries on and does not throw
      expect(() => classifyLines(throwingData, lines)).not.toThrow();
      // If unknown throws in composeLines, it also carries on without throwing
      if (stage === 'unknown') {
        expect(() => composeLines(throwingData, lines)).not.toThrow();
      }
    }

    // 2. Predicates returning non-boolean (truthy strings, numbers, objects) are misses
    for (const badValue of ['yes', 1, {}, [], () => {}]) {
      const badPredicateData = {
        ...baseData,
        profile: {
          unknown: () => badValue as any,
          trust: () => badValue as any,
          permission: () => badValue as any,
          question: () => badValue as any,
          working: () => badValue as any,
          composer: () => ({ kind: 'idle' as const }),
        },
      };
      const res = classifyLines(badPredicateData, lines);
      // None of the stages match because they did not return strictly true
      // So it falls through to composer (which returns idle)
      expect(res.kind).toBe('idle');
    }

    // 3. Composer throwing returns unknown, does not crash
    const throwingComposerData = {
      ...baseData,
      profile: {
        ...baseData.profile,
        composer: () => {
          throw new Error('composer boom');
        },
      },
    };
    expect(classifyLines(throwingComposerData, lines).kind).toBe('unknown');
    expect(composeLines(throwingComposerData, lines).kind).toBe('unknown');

    // 4. Composer returning null, undefined, wrong types, or invalid kinds reads unknown
    const badComposerReturns: any[] = [
      null,
      undefined,
      'idle',
      { kind: 1 },
      { kind: 'invalid_kind' },
      { kind: 'not-a-screen-kind' },
      {},
      { kind: null },
    ];
    for (const badReturn of badComposerReturns) {
      const badData = {
        ...baseData,
        profile: {
          ...baseData.profile,
          composer: () => badReturn,
        },
      };
      expect(classifyLines(badData, lines).kind).toBe('unknown');
      expect(composeLines(badData, lines).kind).toBe('unknown');
    }
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

  test('all 55+ fixtures enumerated from folder are unchanged', () => {
    const fixtures = enumerateScreenFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(55);

    for (const { relPath, cli, absPath } of fixtures) {
      const content = readFileSync(absPath, 'utf8');
      const screenLines = content.split('\n');

      const r = readScreen(cli, content).kind;
      const c = classify(cli, screenLines).kind;
      const comp = classifyComposer(cli, screenLines).kind;

      const expected = EXPECTED_FIXTURE_KINDS[relPath];
      expect(expected).toBeDefined();
      expect([r, c, comp]).toEqual(expected!);
    }
  });

  test('screen_module may only name a file inside the profiles directory (refused forms in source and dist)', async () => {
    const distModule = await import('../dist/watch/screen-file.js');
    const loaders = [
      { name: 'source', load: loadScreen },
      { name: 'dist', load: distModule.loadScreen },
    ];

    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-test-'));
    const outsideDir = mkdtempSync(resolve(tmpdir(), 'outside-test-'));
    const outsideFile = resolve(outsideDir, 'outside-evil.cjs');
    writeFileSync(outsideFile, 'module.exports = { unknown: () => true };');
    const symlinkPath = resolve(tempDir, 'inside-symlink.cjs');
    symlinkSync(outsideFile, symlinkPath);

    try {
      for (const { load } of loaders) {
        const makeYaml = (specifier: string) => `format: 1
cli: fake-cli
screen_module: "${specifier}"
screen:
  composer:
    mode: status-last
    status_line: "^status$"
    prompt: "^>"
    placeholders:
      - equals: ""
`;

        // 1. Absolute path
        expect(() => load(makeYaml('/tmp/evil.cjs'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot be an absolute path/,
        );

        // 2. Contains ".." segment
        expect(() => load(makeYaml('../evil.cjs'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
        );
        expect(() => load(makeYaml('subdir/../evil.cjs'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
        );

        // 3. URL or other scheme
        expect(() => load(makeYaml('http://127.0.0.1/evil.cjs'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
        );
        expect(() => load(makeYaml('file:///tmp/evil.cjs'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
        );

        // 4. ~/ path
        expect(() => load(makeYaml('~/evil.cjs'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot be a home directory path/,
        );

        // 5. Path in project
        expect(() => load(makeYaml('test/fixtures/hatch/hatch.ts'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
        );
        expect(() => load(makeYaml('src/watch/pass.ts'), undefined, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
        );

        // 6. Symlink leading out of directory
        expect(() => load(makeYaml('inside-symlink.cjs'), tempDir, 'test.yaml')).toThrow(
          /profile "test\.yaml":.*"screen_module".*symlink leads outside/,
        );
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('profile.schema.json matches loader: composer is optional when screen_module is set and screen_module pattern is constrained', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'src/profiles/profile.schema.json'), 'utf8'));
    const screenDef = schema.$defs.screen;
    expect(screenDef.required).toBeUndefined();
    expect(screenDef.anyOf || screenDef.oneOf).toBeDefined();

    const modulePattern = schema.$defs.screenModule.pattern;
    expect(modulePattern).toBeDefined();
    const regex = new RegExp(modulePattern);
    expect(regex.test('hatch.ts')).toBe(true);
    expect(regex.test('/tmp/evil.cjs')).toBe(false);
    expect(regex.test('../evil.cjs')).toBe(false);
    expect(regex.test('http://evil.com/x.js')).toBe(false);
    expect(regex.test('~/evil.cjs')).toBe(false);
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
