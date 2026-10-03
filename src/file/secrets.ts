import type { YamlNode } from '../yaml.ts';
import type { Problem } from './types.ts';

// A team file never holds a credential. A value with a known key prefix, a private key or a URL
// with credentials refuses the file. A long random-looking string only warns: channel ids and
// slugs look like one.
const KEY_PREFIXES = [
  'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-',
  'AKIA', 'ASIA', 'AIza', 'lin_api_', 'npm_', 'shpat_', 'dckr_pat_',
];

export function findSecrets(root: YamlNode): { refused: Problem[]; warned: Problem[] } {
  const refused: Problem[] = [];
  const warned: Problem[] = [];
  walk(root, (value, line) => {
    for (const word of value.split(/[\s"'=,;]+/)) {
      if (KEY_PREFIXES.some((prefix) => word.startsWith(prefix) && word.length >= prefix.length + 16)) {
        refused.push({ line, message: 'a value shaped like a key or token: a team file never holds a credential' });
        return;
      }
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      refused.push({ line, message: 'a private key: a team file never holds a credential' });
    } else if (/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value)) {
      refused.push({ line, message: 'a URL with credentials: a team file never holds a credential' });
    } else if (value.split(/\s+/).some(looksRandom)) {
      warned.push({ line, message: 'a long random-looking value: check it is not a credential' });
    }
  });
  return { refused, warned };
}

function walk(node: YamlNode, visit: (value: string, line: number) => void): void {
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string') visit(node.value, node.line);
  } else if (node.kind === 'seq') {
    for (const item of node.items) walk(item, visit);
  } else {
    for (const entry of node.entries) walk(entry.value, visit);
  }
}

function looksRandom(word: string): boolean {
  if (word.length < 32 || !/^[A-Za-z0-9+/_=-]+$/.test(word)) return false;
  const counts = new Map<string, number>();
  for (const c of word) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) entropy -= (count / word.length) * Math.log2(count / word.length);
  return entropy > 4;
}
