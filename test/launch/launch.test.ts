import { describe, expect, test } from 'bun:test';
import { downPlan, formatPlan, herdr, upPlan, type DownSeat, type UpSeat } from '../../src/launch/plan.ts';
import { rulesText, seatRules, type RulesInput } from '../../src/launch/rules.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, parseVersion, shellQuote, versionVerdict } from '../../src/profiles/profile.ts';

const rulesInput: RulesInput = {
  coordinator: 'claude-coordinator-acme',
  rules: ['Run the tests your change touches, not the whole suite.'],
  signature: {
    commit: 'Agent: Claude Opus 5.5 · implementer',
    pullRequest: '**Agent:** Claude Opus 5.5 · implementer',
    commitPosition: 'trailer',
  },
  workspace: { mode: 'worktree', protected: ['.'], branch: '{kind}/{task}' },
};

const claudeCode = profileFor('claude-code');
if (!claudeCode) throw new Error('claude-code has no profile');

describe('profiles', () => {
  test('claude-code, codex and cursor have launch profiles', () => {
    expect(profileFor('claude-code')).toBe(claudeCode);
    expect(profileFor('codex')?.cli).toBe('codex');
    expect(profileFor('cursor')?.cli).toBe('cursor');
    expect(profileFor('constructor')).toBeNull();
  });

  test('a version is read from the CLI output', () => {
    expect(parseVersion('2.1.288 (Claude Code)')).toEqual([2, 1, 288]);
    expect(parseVersion('herdr 0.7.1')).toEqual([0, 7, 1]);
    expect(parseVersion('no version')).toBeNull();
  });

  test('a version is placed against the tested range', () => {
    const tested = { from: '2.1.200', to: '2.1.288' };
    expect(versionVerdict('2.1.288 (Claude Code)', tested)).toBe('tested');
    expect(versionVerdict('2.1.200', tested)).toBe('tested');
    expect(versionVerdict('2.1.99', tested)).toBe('older');
    expect(versionVerdict('2.2', tested)).toBe('newer');
    expect(versionVerdict('2.1.288.1', tested)).toBe('newer');
    expect(versionVerdict('?', tested)).toBe('unread');
  });

  test('a model id maps to the model and version of the file', () => {
    expect(claudeCode.modelOf('claude --model claude-opus-5-5')).toEqual({ model: 'Claude Opus', version: '5.5' });
    expect(claudeCode.modelOf('claude --model=claude-fable-5-1 --verbose')).toEqual({
      model: 'Claude Fable',
      version: '5.1',
    });
    expect(claudeCode.modelOf('claude --model claude-haiku-4-5-20251001')).toEqual({
      model: 'Claude Haiku',
      version: '4.5',
    });
    expect(claudeCode.modelOf('claude --model claude-opus-5')).toEqual({ model: 'Claude Opus', version: '5' });
  });

  test('an unknown model id or a launcher maps to nothing', () => {
    expect(claudeCode.modelOf('team-deepseek')).toBeNull();
    expect(claudeCode.modelOf('claude --model claude-nova-9-1')).toBeNull();
    expect(claudeCode.modelOf('claude --model opus')).toBeNull();
  });

  test('shell words are quoted only when they need it', () => {
    expect(shellQuote('--model')).toBe('--model');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's $HOME; rm")).toBe("'it'\\''s $HOME; rm'");
    expect(shellQuote('')).toBe("''");
  });

  test('the launch gets the unattended flag, the option and the rules, quoted', () => {
    expect(launchCommand(claudeCode, 'claude --model claude-opus-5-5 ', "Don't stop.\n- two")).toBe(
      "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt 'Don'\\''t stop.\n- two'",
    );
  });
});

describe('the rules of a seat', () => {
  test("come in order: the profile's, the file's, the signature, the workspace's", () => {
    expect(seatRules(rulesInput)).toEqual([
      'End every commit message and every pull request body with your signature, given below.',
      'Never stop at a question: tell the coordinator (claude-coordinator-acme) in one line and keep working.',
      'Never run `team trust` or `team approve`, and never edit `trust:` in the team file.',
      'In a protected checkout, never switch the branch, reset or commit.',
      'Run the tests your change touches, not the whole suite.',
      'Your signature in a commit message, as a trailer, in a last paragraph of its own that holds trailers only: Agent: Claude Opus 5.5 · implementer',
      'Your signature in a pull request body, as its last line: **Agent:** Claude Opus 5.5 · implementer',
      'Protected checkouts, relative to the project root: .',
      'Work on the code in the worktree your brief names, never in the checkout you started in. Branches are named {kind}/{task}.',
    ]);
  });

  test('a shared seat gets no worktree rule, and the position is said as the file has it', () => {
    const rules = seatRules({
      ...rulesInput,
      signature: { ...rulesInput.signature, commitPosition: 'last-line' },
      workspace: { mode: 'shared', protected: [] },
    });
    expect(rules).toHaveLength(7);
    expect(rules[5]).toStartWith('Your signature in a commit message, as its last line: ');
  });

  test('are one text, a rule per line', () => {
    const text = rulesText(rulesInput);
    expect(text.split('\n')).toHaveLength(10);
    expect(text).toStartWith('Rules for this session, from the team file:\n- End every commit');
  });
});

describe('up --dry-run', () => {
  const seat = (name: string, overrides: Partial<UpSeat> = {}): UpSeat => ({
    name,
    cli: 'claude-code',
    launch: 'claude --model claude-opus-5-5',
    cwd: '.',
    label: name,
    stopped: false,
    rules: 'Rules.',
    ...overrides,
  });

  test('a session other than default is named in every command', () => {
    expect(herdr('acme-web', 'agent', 'list')).toEqual(['herdr', '--session', 'acme-web', 'agent', 'list']);
    expect(herdr('default', 'agent', 'list')).toEqual(['herdr', 'agent', 'list']);
  });

  test('prints every herdr command in order and says nothing was run', () => {
    const plan = upPlan({
      root: '/work/acme-web',
      session: 'acme-web',
      sessionRunning: false,
      seats: [
        seat('claude-coordinator-acme'),
        seat('grok-acme', { cli: 'grok' }),
        seat('grok-acme', { stopped: true }),
        seat('claude-docs', { cwd: 'docs', label: 'docs' }),
      ],
    });
    expect(formatPlan(plan)).toBe(
      [
        '+ env -i HOME=$HOME USER=$USER LOGNAME=$LOGNAME PATH=$PATH SHELL=$SHELL TERM=$TERM LANG=$LANG herdr --session acme-web server',
        '    (detached, in a clean environment; SSH_AUTH_SOCK is passed too when it is set)',
        '  wait until session acme-web is running (30 s at most)',
        '+ herdr --session acme-web workspace create --cwd /work/acme-web --label claude-coordinator-acme --no-focus',
        "+ herdr --session acme-web pane run <pane of claude-coordinator-acme> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules.'",
        '  wait until claude-coordinator-acme shows its idle prompt (90 s at most); anything else is reported, its workspace closed without input, and the seat left out',
        '+ herdr --session acme-web agent rename <pane of claude-coordinator-acme> claude-coordinator-acme',
        '  skip grok-acme: no launch profile for `grok` in this version; left out',
        '  skip grok-acme: stopped in the file; start it with `team add grok-acme`',
        '+ herdr --session acme-web workspace create --cwd /work/acme-web/docs --label docs --no-focus',
        "+ herdr --session acme-web pane run <pane of docs> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules.'",
        '  wait until claude-docs shows its idle prompt (90 s at most); anything else is reported, its workspace closed without input, and the seat left out',
        '+ herdr --session acme-web agent rename <pane of docs> claude-docs',
        '+ herdr --session acme-web workspace create --cwd /work/acme-web --label watchdog --no-focus',
        "+ herdr --session acme-web pane run <pane of watchdog> 'team watch --session acme-web'",
        '    (a desktop notification follows when the watch exits)',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test('a running session is not started again', () => {
    const plan = upPlan({ root: '/work/a', session: 'a', sessionRunning: true, seats: [] });
    expect(plan.map((step) => step.kind)).toEqual(['run', 'run']);
    expect(plan[0]).toMatchObject({
      argv: ['herdr', '--session', 'a', 'workspace', 'create', '--cwd', '/work/a', '--label', 'watchdog', '--no-focus'],
    });
  });

  test('never holds a command that answers, closes or deletes', () => {
    const plan = upPlan({ root: '/work/a', session: 'a', sessionRunning: false, seats: [seat('one'), seat('two')] });
    const verbs = plan.flatMap((step) =>
      step.kind === 'run' && step.argv[0] === 'herdr' ? [step.argv.slice(3, 5).join(' ')] : [],
    );
    expect(new Set(verbs)).toEqual(new Set(['workspace create', 'pane run', 'agent rename']));
  });
});

describe('down --dry-run', () => {
  const seat = (name: string, state: DownSeat['state'] = 'free'): DownSeat => ({
    name,
    cli: 'claude-code',
    pane: `${name}:p1`,
    workspace: name,
    state,
  });

  test('stops each free seat, then the watch, then the empty session', () => {
    const plan = downPlan({ session: 'acme-web', seats: [seat('w1'), seat('w2')], extra: 0, watchPid: 4242, keep: [] });
    expect(formatPlan(plan)).toBe(
      [
        '+ herdr --session acme-web pane run w1:p1 /exit',
        "  wait until w1's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close w1',
        '+ herdr --session acme-web pane run w2:p1 /exit',
        "  wait until w2's pane is back at its shell (30 s at most); on a time-out it is left as it is",
        '+ herdr --session acme-web workspace close w2',
        '+ kill 4242',
        '    (the watch)',
        '+ herdr session stop acme-web',
        'dry run: nothing was run',
        '',
      ].join('\n'),
    );
  });

  test.each([
    ['working', 'w1: is working (`--wait` waits for it); left running'],
    ['blocked', 'w1: is blocked at a prompt, which `team` never answers; left running'],
    ['unknown', 'w1: shows a screen the profile does not recognise; left running'],
    ['unsent', 'w1: holds unsent text in its input box; left running'],
  ] as const)('a %s seat is left running and the session with it', (state, text) => {
    const plan = downPlan({ session: 's', seats: [seat('w1', state)], extra: 0, watchPid: null, keep: [] });
    expect(plan).toEqual([
      { kind: 'skip', text },
      { kind: 'skip', text: 'session s: not stopped, 1 agent left in it' },
    ]);
  });

  test("a seat's call leaves the coordinator, the operator and the session", () => {
    const plan = downPlan({
      session: 's',
      seats: [seat('lead'), seat('w1')],
      extra: 0,
      watchPid: null,
      keep: ['lead'],
    });
    expect(plan.map((step) => step.kind)).toEqual(['skip', 'run', 'wait', 'run', 'skip']);
    expect(plan.at(-1)).toEqual({ kind: 'skip', text: 'session s: not stopped, 1 agent left in it' });
  });

  test('agents the file does not name are never closed, and keep the session up', () => {
    const plan = downPlan({ session: 's', seats: [seat('w1')], extra: 2, watchPid: null, keep: [] });
    expect(plan.at(-1)).toEqual({ kind: 'skip', text: 'session s: not stopped, 2 agents left in it' });
  });

  test('the default session is never stopped', () => {
    const plan = downPlan({ session: 'default', seats: [seat('w1')], extra: 0, watchPid: null, keep: [] });
    expect(plan[0]).toMatchObject({ kind: 'run', argv: ['herdr', 'pane', 'run', 'w1:p1', '/exit'] });
    expect(plan.at(-1)).toEqual({ kind: 'skip', text: "session default: herdr's default session is never stopped" });
  });

  test('a seat of a CLI without a profile is left running', () => {
    const plan = downPlan({
      session: 's',
      seats: [{ ...seat('grok-acme'), cli: 'grok' }],
      extra: 0,
      watchPid: null,
      keep: [],
    });
    expect(plan[0]).toEqual({
      kind: 'skip',
      text: 'grok-acme: no launch profile for `grok` in this version; left running',
    });
  });
});
