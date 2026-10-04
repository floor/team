import { readFileSync } from 'node:fs';

// The one place the CLI's version is read. `--version` prints it and `team init` pins the
// schema URL's tag to it, so the URL can never name a release the CLI doesn't report.
export function version(): string {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(text) as { version: string }).version;
}
