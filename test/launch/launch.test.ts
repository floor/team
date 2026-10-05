import { describe, expect, test } from 'bun:test';
import { paneExcerpt } from '../../src/launch/execute.ts';
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
    expect(claudeCode.modelOf('claude --model foo --model claude-opus-5-5')).toEqual({ model: 'Claude Opus', version: '5.5' });
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
    const text = rulesText(rulesInput, 'message');
    expect(text.split('\n')).toHaveLength(11);
    expect(text).toStartWith('Rules for this session, from the team file:\n- End every commit');
  });

  const closingMessage = 'These are standing rules, not a task: reply ready and wait for your brief.';
  const closingOption = 'These are standing rules, not a task.';

  test('a first message ends with the standing-rules line, whatever the file holds', () => {
    const lastLine = (input: RulesInput) => rulesText(input, 'message').split('\n').at(-1);
    // A seat with rules, a seat with only signature lines, and a team file with an empty `rules:`.
    expect(lastLine(rulesInput)).toBe(closingMessage);
    expect(lastLine({ ...rulesInput, rules: [] })).toBe(closingMessage);
    expect(lastLine({ ...rulesInput, rules: [], workspace: { mode: 'shared', protected: [] } })).toBe(closingMessage);
  });

  test('a launch option ends with only the standing-rules line, whatever the file holds', () => {
    const lastLine = (input: RulesInput) => rulesText(input, 'option').split('\n').at(-1);
    // A system prompt stays in force on every later turn, so it never asks for the ready reply.
    expect(lastLine(rulesInput)).toBe(closingOption);
    expect(lastLine({ ...rulesInput, rules: [] })).toBe(closingOption);
    expect(lastLine({ ...rulesInput, rules: [], workspace: { mode: 'shared', protected: [] } })).toBe(closingOption);
  });

  test('a file whose rules already end with the closing line gets it once, last', () => {
    const message = rulesText({ ...rulesInput, rules: [...rulesInput.rules, closingMessage] }, 'message');
    expect(message.split(closingMessage)).toHaveLength(2);
    expect(message.split('\n').at(-1)).toBe(closingMessage);
    expect(message).not.toContain(`- ${closingMessage}`);

    const option = rulesText({ ...rulesInput, rules: [...rulesInput.rules, closingOption] }, 'option');
    expect(option.split(closingOption)).toHaveLength(2);
    expect(option.split('\n').at(-1)).toBe(closingOption);
    expect(option).not.toContain(`- ${closingOption}`);
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
        "+ herdr --session acme-web pane run <pane of claude-docs> 'AGENT_UNATTENDED=1 claude --model claude-opus-5-5 --dangerously-skip-permissions --append-system-prompt Rules.'",
        '  wait until claude-docs shows its idle prompt (90 s at most); anything else is reported, its workspace closed without input, and the seat left out',
        '+ herdr --session acme-web agent rename <pane of claude-docs> claude-docs',
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
        '    (stopped, then cleared: the session this run stopped, so a later `up` starts from the beginning)',
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

describe('the pane lines a report carries', () => {
  const command =
    "AGENT_UNATTENDED=1 claude --model claude-opus-5-5 'Run the tests your change touches, not the whole suite.'";

  test("starts at the launch line's own echo when it is within reach", () => {
    const screen = `❯ ${command}\nzsh: no such file or directory\n~ ❯`;
    expect(paneExcerpt(screen, command)).toBe(
      `  | ❯ ${command}\n  | zsh: no such file or directory\n  | ~ ❯\n`,
    );
  });

  test('a failure naming the program is not taken for the echo', () => {
    // The launch line of the capture behind this: the error repeats its program and its path,
    // the echo holds the line itself.
    const short = 'zsh ../tools/x.sh --agent';
    const screen = `❯ ${short}\nzsh: can't open input file: ../tools/x.sh\n~ ❯`;
    expect(paneExcerpt(screen, short)).toBe(
      `  | ❯ ${short}\n  | zsh: can't open input file: ../tools/x.sh\n  | ~ ❯\n`,
    );
  });

  test('keeps the newest six lines when the echo scrolled out of reach', () => {
    const lines = ['one', 'two', command, 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const newest = lines.slice(-6).map((line) => `  | ${line}\n`).join('');
    expect(paneExcerpt(lines.join('\n'), command)).toBe(newest);
    expect(paneExcerpt(lines.join('\n'), command)).toContain('  | four\n');
  });

  test('styling is stripped and empty lines are dropped', () => {
    expect(paneExcerpt(`\n\n\u001b[31m❯ ${command}\u001b[0m\n \n`, command)).toBe(`  | ❯ ${command}\n`);
  });

  test('nothing to show reads as an empty excerpt', () => {
    expect(paneExcerpt(null, command)).toBe('');
    expect(paneExcerpt('', command)).toBe('');
    expect(paneExcerpt('\n \t\n', command)).toBe('');
  });

  test('a command too short to look for leaves the screen as it is', () => {
    expect(paneExcerpt('one\ntwo', 'x')).toBe('  | one\n  | two\n');
  });

  test('every control character and escape sequence is out of the lines', () => {
    // The reviewer's probe, one sample each: a carriage return would overwrite the report on the
    // terminal, and a private CSI, a backspace, a bell, a two-character escape and a DCS payload
    // must not survive as control or as the sequence's own text.
    const screens = [
      `❯ ${command}\rfake-overwrite`,
      `❯ ${command}\n\u001b[?25lhidden\u001b[?25h`,
      `❯ ${command}\n\u0008\u0008\u0008gone`,
      `❯ ${command}\n\u0007bell`,
      `❯ ${command}\n\u001b=keypad`,
      `❯ ${command}\n\u001bP1;2|payload\u001b\\after`,
    ];
    for (const screen of screens) {
      const out = paneExcerpt(screen, command);
      expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(out).not.toContain('?25l');
      expect(out).not.toContain('payload');
    }
  });

  test('string sequences are removed whole whichever introducer and terminator are mixed', () => {
    // The reviewer's mixed probe: an ESC-introduced OSC or DCS ended by the C1 ST, and a
    // C1-introduced one ended by `ESC \`, each left its payload behind. Every string sequence —
    // OSC, DCS, APC, PM, SOS — is removed with its payload whichever introducer began it
    // (7-bit `ESC x` or the 8-bit C1) and whichever terminator ends it (`ESC \`, the C1 ST, or
    // BEL for an OSC), in any mix.
    const cases = [
      '\u001b]0;secret\u009cafter', // ESC OSC, C1 ST
      '\u009d0;secret\u001b\\after', // C1 OSC, ESC \
      '\u001bP1|secret\u009cafter', // ESC DCS, C1 ST
      '\u0090q|secret\u001b\\after', // C1 DCS, ESC \
      '\u001b]0;secret\u0007after', // ESC OSC, BEL
      '\u009d0;secret\u0007after', // C1 OSC, BEL
      '\u001bP1|secret\u001b\\after', // ESC DCS, ESC \
      '\u0090q|secret\u009cafter', // C1 DCS, C1 ST
      '\u001b_q|secret\u001b\\after', // ESC APC
      '\u009eQ|secret\u009cafter', // C1 PM
      '\u001bXq|secret\u001b\\after', // ESC SOS
      '\u0098Q|secret\u009cafter', // C1 SOS
    ];
    for (const one of cases) {
      const out = paneExcerpt(`❯ ${command}\n${one}\n~ ❯`, command);
      expect(out).not.toContain('secret');
      expect(out).toContain('  | after\n');
    }
  });

  test('a string sequence spanning the six-line cut is removed whole', () => {
    // The reviewer's cut-spanning probe: an OSC begins before the eventual six-line tail and ends
    // with `ESC \` in the tail. The entire sequence and its payload must be removed whole.
    const lines = [
      `❯ ${command}`,
      'old line',
      '\u001b]0;secret-one',
      'secret-two',
      'secret-three',
      'secret-four',
      'secret-five',
      'secret-six\u001b\\after',
    ];
    const out = paneExcerpt(lines.join('\n'), command);
    expect(out).not.toContain('secret');
    expect(out).toContain('  | after\n');
  });

  test('an opener in the dropped part and its terminator in the kept part are removed whole', () => {
    const lines = [
      'dropped line 1',
      '\u001b]0;secret-dropped',
      'dropped line 2',
      'dropped line 3',
      'dropped line 4',
      'dropped line 5',
      `❯ ${command}`,
      'kept line 1',
      'kept line 2\u001b\\after-terminator',
    ];
    const out = paneExcerpt(lines.join('\n'), command);
    expect(out).not.toContain('secret');
    expect(out).toContain('  | after-terminator\n');
  });

  test('an opener in the kept part with no terminator is removed to the end of the text', () => {
    const lines = [
      `❯ ${command}`,
      'kept line 1',
      '\u001b]0;secret-unterminated',
      'kept line 2',
      'kept line 3',
    ];
    const out = paneExcerpt(lines.join('\n'), command);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('kept line 2');
    expect(out).not.toContain('kept line 3');
    expect(out).toContain('  | kept line 1\n');
  });

  test('an unterminated string sequence is removed to the end of the text', () => {
    const out = paneExcerpt(`❯ ${command}\n\u001b]0;secret-no-end\nnext line\n~ ❯`, command);
    expect(out).not.toContain('secret-no-end');
    expect(out).not.toContain('next line');
    expect(out).toBe(`  | ❯ ${command}\n`);
  });

  test('a line longer than the bound is cut to 200 characters and marked', () => {
    const out = paneExcerpt(`❯ ${command}\n${'x'.repeat(200_000)}\n~ ❯`, command);
    expect(out).toContain(`  | ${'x'.repeat(200)}…\n`);
    const longest = Math.max(...out.split('\n').map((line) => line.length));
    expect(longest).toBe('  | '.length + 200 + '…'.length);
  });
});
