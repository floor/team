import { createInterface } from 'node:readline';
import type { Command } from '../io.ts';
import { classify, classifyComposer } from '../watch/screen.ts';
import { parseYaml } from '../yaml.ts';

// One JSON request per line, one JSON answer per line. A port implements the same
// three operations; this is the TypeScript one. It is not listed in `team --help`.

type Request = { op?: unknown; cli?: unknown; lines?: unknown; text?: unknown };

/** The answer for one request line. A line that is not a request is an error object. */
export function respond(line: string): string {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    return JSON.stringify({ error: 'the line is not JSON' });
  }
  if (request === null || typeof request !== 'object') return JSON.stringify({ error: 'a request needs an op' });
  if (request.op === 'classify' || request.op === 'composer') {
    if (typeof request.cli !== 'string' || !Array.isArray(request.lines) || request.lines.some((item) => typeof item !== 'string')) {
      return JSON.stringify({ error: 'classify needs a cli and lines of text' });
    }
    const screen = request.op === 'classify' ? classify(request.cli, request.lines) : classifyComposer(request.cli, request.lines);
    return JSON.stringify({ kind: screen.kind });
  }
  if (request.op === 'yaml') {
    if (typeof request.text !== 'string') return JSON.stringify({ error: 'yaml needs text' });
    try {
      parseYaml(request.text);
      return JSON.stringify({ ok: true });
    } catch {
      return JSON.stringify({ ok: false });
    }
  }
  return JSON.stringify({ error: 'unknown op' });
}

const adapter: Command = async (_argv, io) => {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.length === 0) continue;
    io.stdout(`${respond(line)}\n`);
  }
  return 0;
};

export default adapter;
