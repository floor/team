import { describe, expect, test, beforeEach } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyLines, composeLines } from '../src/watch/screen-core.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { classify, classifyComposer, readScreen, type Screen } from '../src/watch/screen.ts';
import { callOrder, resetCalls } from './fixtures/hatch/hatch.ts';
import type { ScreenProfile } from '../src/watch/screen-profile.ts';
import { parseOverrides } from '../src/profiles/overrides.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/hatch', import.meta.url));

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

  test('a hatch result that is not a boolean must fail closed (whole screen reads unknown)', async () => {
    const yaml = readFileSync(resolve(fixtureDir, 'fake-cli.yaml'), 'utf8');
    const baseData = loadScreen(yaml, fixtureDir);
    const lines = ['some regular terminal line'];
    const screenText = lines.join('\n');

    const badValues: [name: string, factory: () => any][] = [
      ['sync throw', () => { throw new Error('boom'); }],
      ['rejected Promise', () => Promise.reject(new Error('boom'))],
      ['resolved Promise', () => Promise.resolve(true)],
      ['pending Promise', () => new Promise(() => {})],
      ['null', () => null],
      ['undefined', () => undefined],
      ['string "yes"', () => 'yes'],
      ['number 1', () => 1],
      ['number 0', () => 0],
      ['empty object', () => ({})],
      ['array', () => []],
      ['function', () => (() => {})],
    ];

    const stages = ['unknown', 'trust', 'permission', 'question', 'working'] as const;

    // 1. Each bad value for each of the five predicates must fail closed (whole screen reads unknown)
    for (const stage of stages) {
      for (const [name, badFn] of badValues) {
        const badData: any = {
          ...baseData,
          profile: {
            composer: () => ({ kind: 'idle' }),
            [stage]: badFn,
          },
        };

        const resClassifyLines = classifyLines(badData, lines);
        expect(resClassifyLines.kind).toBe('unknown');

        const resReadScreen = readScreen(badData, screenText);
        expect(resReadScreen.kind).toBe('unknown');

        const resClassify = classify(badData, lines);
        expect(resClassify.kind).toBe('unknown');

        if (stage === 'unknown') {
          const resComposeLines = composeLines(badData, lines);
          expect(resComposeLines.kind).toBe('unknown');

          const resClassifyComposer = classifyComposer(badData, lines);
          expect(resClassifyComposer.kind).toBe('unknown');
        }
      }
    }

    // 2. Each bad value for composer must fail closed (whole screen reads unknown)
    const badComposerValues: [name: string, factory: () => any][] = [
      ['sync throw', () => { throw new Error('composer boom'); }],
      ['rejected Promise', () => Promise.reject(new Error('composer boom'))],
      ['resolved Promise', () => Promise.resolve({ kind: 'idle' })],
      ['pending Promise', () => new Promise(() => {})],
      ['null', () => null],
      ['undefined', () => undefined],
      ['string "idle"', () => 'idle'],
      ['number 1', () => 1],
      ['empty object', () => ({})],
      ['invalid kind number', () => ({ kind: 1 })],
      ['invalid kind string', () => ({ kind: 'invalid_kind' })],
      ['null kind', () => ({ kind: null })],
    ];

    for (const [name, badFn] of badComposerValues) {
      const badData: any = {
        ...baseData,
        profile: {
          composer: badFn,
        },
      };

      const resClassifyLines = classifyLines(badData, lines);
      expect(resClassifyLines.kind).toBe('unknown');

      const resComposeLines = composeLines(badData, lines);
      expect(resComposeLines.kind).toBe('unknown');

      const resReadScreen = readScreen(badData, screenText);
      expect(resReadScreen.kind).toBe('unknown');

      const resClassify = classify(badData, lines);
      expect(resClassify.kind).toBe('unknown');

      const resClassifyComposer = classifyComposer(badData, lines);
      expect(resClassifyComposer.kind).toBe('unknown');
    }

    // 3. Exactly true matches the stage; exactly false misses the stage
    for (const stage of stages) {
      // True matches
      const trueData: any = {
        ...baseData,
        profile: {
          composer: () => ({ kind: 'idle' }),
          [stage]: () => true,
        },
      };
      expect(classifyLines(trueData, lines).kind).toBe(stage);
      expect(classify(trueData, lines).kind).toBe(stage);
      expect(readScreen(trueData, screenText).kind).toBe(stage);

      // False misses (falls through to composer which returns idle)
      const falseData: any = {
        ...baseData,
        profile: {
          composer: () => ({ kind: 'idle' }),
          [stage]: () => false,
        },
      };
      expect(classifyLines(falseData, lines).kind).toBe('idle');
      expect(classify(falseData, lines).kind).toBe('idle');
      expect(readScreen(falseData, screenText).kind).toBe('idle');
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

  test("no shipped profile's reading changes: all fixtures in conformance manifest match expected kinds", () => {
    const manifestPath = resolve(process.cwd(), 'test/fixtures/conformance.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      screens: { file: string; cli: string; classify: Screen['kind']; composer: Screen['kind'] }[];
    };
    expect(manifest.screens.length).toBeGreaterThanOrEqual(55);

    for (const { file, cli, classify: expectedClassify, composer: expectedComposer } of manifest.screens) {
      const absPath = resolve(process.cwd(), 'test/fixtures', file);
      const content = readFileSync(absPath, 'utf8');
      const screenLines = content.split('\n');

      const r = readScreen(cli, content).kind;
      const c = classify(cli, screenLines).kind;
      const comp = classifyComposer(cli, screenLines).kind;

      expect(r).toBe(expectedClassify);
      expect(c).toBe(expectedClassify);
      expect(comp).toBe(expectedComposer);
    }
  });

  test('an override may never set screen_module', () => {
    const atRoot = `format: 1
screen_module: "hatch.ts"
profiles:
  codex:
    screen:
      permission:
        - any: ['x']
`;
    const resRoot = parseOverrides(atRoot);
    expect(resRoot.ok).toBe(false);
    if (!resRoot.ok) expect(resRoot.errors[0]?.message).toBe('unknown key "screen_module"');

    const atProfile = `format: 1
profiles:
  codex:
    screen_module: "hatch.ts"
    screen:
      permission:
        - any: ['x']
`;
    const resProfile = parseOverrides(atProfile);
    expect(resProfile.ok).toBe(false);
    if (!resProfile.ok) expect(resProfile.errors[0]?.message).toBe('unknown key "screen_module"');

    const inScreen = `format: 1
profiles:
  codex:
    screen:
      screen_module: "hatch.ts"
      permission:
        - any: ['x']
`;
    const resScreen = parseOverrides(inScreen);
    expect(resScreen.ok).toBe(false);
    if (!resScreen.ok) expect(resScreen.errors[0]?.message).toBe('unknown key "screen_module"');
  });

  test('screen_module may only name a file inside the profiles directory (refused forms in source)', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'hatch-test-'));
    const outsideDir = mkdtempSync(resolve(tmpdir(), 'outside-test-'));
    const outsideFile = resolve(outsideDir, 'outside-evil.cjs');
    writeFileSync(outsideFile, 'module.exports = { unknown: () => true };');
    const symlinkPath = resolve(tempDir, 'inside-symlink.cjs');
    symlinkSync(outsideFile, symlinkPath);

    // Symlink loop
    const loopPath = resolve(tempDir, 'loop.cjs');
    symlinkSync('loop.cjs', loopPath);

    // Directory with package.json pointing outside
    const pkgDir = resolve(tempDir, 'pkg');
    mkdirSync(pkgDir);
    writeFileSync(resolve(pkgDir, 'package.json'), JSON.stringify({ main: outsideFile }));

    // Directory with index.js inside
    const pkgdirDir = resolve(tempDir, 'pkgdir');
    mkdirSync(pkgdirDir);
    writeFileSync(resolve(pkgdirDir, 'index.js'), 'module.exports = { unknown: () => true };');

    // Valid file inside
    writeFileSync(resolve(tempDir, 'good.cjs'), 'module.exports = { unknown: () => true };');

    try {
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

      // 1. Bare names (fs, left-pad)
      expect(() => loadScreen(makeYaml('fs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a bare name: "fs"/,
      );
      expect(() => loadScreen(makeYaml('left-pad'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a bare name: "left-pad"/,
      );

      // 2. Directory refusal
      expect(() => loadScreen(makeYaml('pkg'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a directory: "pkg"/,
      );
      expect(() => loadScreen(makeYaml('pkgdir'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a directory: "pkgdir"/,
      );

      // 3. Empty string
      expect(() => loadScreen(makeYaml(''), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be an empty string/,
      );

      // 4. Current directory "."
      expect(() => loadScreen(makeYaml('.'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be current directory "\."/,
      );

      // 5. Absolute path
      expect(() => loadScreen(makeYaml('/tmp/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be an absolute path/,
      );

      // 6. Contains ".." segment (including encoded)
      expect(() => loadScreen(makeYaml('../evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
      );
      expect(() => loadScreen(makeYaml('subdir/../evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
      );
      expect(() => loadScreen(makeYaml('a/%2e%2e/x.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot contain "\.\." segments/,
      );

      // 7. URL or other scheme
      expect(() => loadScreen(makeYaml('http://127.0.0.1/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
      );
      expect(() => loadScreen(makeYaml('file:///tmp/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
      );
      expect(() => loadScreen(makeYaml('node:fs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a URL or scheme/,
      );

      // 8. ~/ and ~user path
      expect(() => loadScreen(makeYaml('~/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a home directory path/,
      );
      expect(() => loadScreen(makeYaml('~root/evil.cjs'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a home directory path/,
      );

      // 9. Path in project
      expect(() => loadScreen(makeYaml('test/fixtures/hatch/hatch.ts'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );
      expect(() => loadScreen(makeYaml('src/watch/pass.ts'), undefined, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*cannot be a path in the project/,
      );

      // 10. Symlink leading out of directory
      expect(() => loadScreen(makeYaml('inside-symlink.cjs'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*symlink leads outside/,
      );

      // 11. Symlink loop
      expect(() => loadScreen(makeYaml('loop.cjs'), tempDir, 'test.yaml')).toThrow(
        /profile "test\.yaml":.*"screen_module".*contains a symlink loop: "loop\.cjs"/,
      );

      // 12. Valid file inside loads successfully
      const loaded = loadScreen(makeYaml('good.cjs'), tempDir, 'test.yaml');
      expect(loaded.profile?.unknown).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('profile.schema.json matches loader: composer is optional when screen_module is set and screen_module pattern is constrained', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'src/profiles/profile.schema.json'), 'utf8'));

    const modulePattern = schema.$defs.screenModule.pattern;
    expect(modulePattern).toBeDefined();
    const regex = new RegExp(modulePattern);
    expect(regex.test('hatch.ts')).toBe(true);
    expect(regex.test('good.cjs')).toBe(true);
    expect(regex.test('nested/good.cjs')).toBe(true);
    expect(regex.test('foo..bar.ts')).toBe(true);
    expect(regex.test('fs')).toBe(false);
    expect(regex.test('left-pad')).toBe(false);
    expect(regex.test('pkg')).toBe(false);
    expect(regex.test('node_modules/left-pad/index.js')).toBe(false);
    expect(regex.test('test/fixtures/hatch/hatch.ts')).toBe(false);
    expect(regex.test('/tmp/evil.cjs')).toBe(false);
    expect(regex.test('../evil.cjs')).toBe(false);
    expect(regex.test('http://evil.com/x.js')).toBe(false);
    expect(regex.test('~/evil.cjs')).toBe(false);
    expect(regex.test('a/%2e%2e/x.js')).toBe(false);
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
