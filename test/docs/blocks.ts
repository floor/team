// The fenced examples of one command reference page. A page is prose plus four kinds of fence:
//
//   ```yaml file=<path>      a file the fixture gets, written before anything runs
//   ```commit (email=<addr>) one commit of the fixture's history; the block's text is its message
//   ```fixture               the world the page's examples run in (see spec.ts)
//   ```console (caller=<who>)a transcript: `$ ` lines are commands, the rest is the output to match
//
// A fence of any other kind is not read, so prose may quote config freely. An unclosed fence is an
// error: the docs check exists to catch that, not to skip it.

export type Block = {
  kind: string;
  /** `key=value` pairs on the opening line, values optionally quoted. */
  attrs: Record<string, string>;
  /** The lines between the fences, without the last newline. */
  text: string;
  /** The 1-based line of the block's first line, for error messages. */
  line: number;
};

const OPEN = /^```(\S+)(.*)$/;
const CLOSE = /^```\s*$/;

export function attributes(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of rest.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)=("[^"]*"|'[^']*'|\S+)/g)) {
    const raw = match[2] as string;
    attrs[match[1] as string] = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

export function blocksOf(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const found: Block[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = OPEN.exec(lines[index] as string);
    if (!open) continue;
    const kind = open[1] as string;
    const start = index + 2;
    const body: string[] = [];
    for (index++; index < lines.length && !CLOSE.test(lines[index] as string); index++) {
      body.push(lines[index] as string);
    }
    if (index >= lines.length) throw new Error(`unclosed \`\`\`${kind} fence at line ${start - 1}`);
    found.push({ kind, attrs: attributes(open[2] ?? ''), text: body.join('\n'), line: start });
  }
  return found;
}

export type TranscriptStep = {
  /** The command, without the leading `$ ` and without the `; echo "exit $?"` suffix. */
  command: string;
  /** The output the page shows, or '' when the page shows none. */
  expected: string;
  /** The command was written as `team … ; echo "exit $?"`: the page shows the code too. */
  showsExit: boolean;
  line: number;
};

/** `team doctor; echo "exit $?"` asks the page to show the exit code; it is not an argument. */
export const EXIT_SUFFIX = '; echo "exit $?"';

/** One console block, split into commands and the output each must produce. */
export function transcript(text: string, start: number): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  let command: string | null = null;
  let commandLine = start;
  let commandExit = false;
  let output: string[] = [];
  const flush = () => {
    if (command === null) return;
    while (output.length && output[output.length - 1] === '') output.pop();
    steps.push({
      command,
      expected: output.length ? `${output.join('\n')}\n` : '',
      showsExit: commandExit,
      line: commandLine,
    });
    command = null;
    output = [];
    commandExit = false;
  };
  let number = start;
  for (const line of text.split('\n')) {
    if (line.startsWith('$ ')) {
      flush();
      const written = line.slice(2).trimEnd();
      commandExit = written.endsWith(EXIT_SUFFIX);
      command = commandExit ? written.slice(0, -EXIT_SUFFIX.length).trimEnd() : written;
      commandLine = number;
    } else {
      output.push(line);
    }
    number++;
  }
  flush();
  return steps;
}
