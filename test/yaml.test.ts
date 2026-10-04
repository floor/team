import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { YamlError, parseYaml, toValue } from '../src/yaml.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

// Every accepted document must read exactly as a full YAML parser reads it.
const accepted: Record<string, string> = {
  'the complete example': example,
  'scalars': 'a: 1\nb: -2\nc: 3.5\nd: 4.10\ne: true\nf: False\ng: null\nh: ~\ni:\nj: 0x1F\nk: 1e3\nl: .5\nm: text\nn: 25%\no: 120s',
  'YAML 1.1 words stay text': 'a: yes\nb: no\nc: on\nd: off\ne: 012\nf: 1_000',
  'quoted': 'a: "x: y # z"\nb: \'it\'\'s\'\nc: "\\\\bWEB-[0-9]+\\\\b"\nd: "tab\\there"\ne: "\\u00e9"\nf: \'4.10\'\ng: ""',
  'comments': '# top\na: 1 # one\nb: x#y\nc: don\'t # stop\n\n  # indented\nd: "#no"',
  'block map and list': 'a:\n  b:\n    c: 1\n  d:\n    - 1\n    - x\ne:\n- 1\n- 2\nf: 3',
  'list of maps': '- name: a\n  n: 1\n- name: b\n  nested:\n    k: v\n  list:\n    - 1\n- plain',
  'flow': 'a: [1, two, "3", [4, 5], {k: v}]\nb: { kind: linear, team: WEB, n: 2 }\nc: []\nd: {}\ne: [.]\nf: [jane@acme.example]',
  'paths and patterns': 'trust:\n  - .\n  - ../worktrees/acme-web/*\nurl: https://example.com/a?b=c\npath: ../worktrees/{repo}/{task}',
  'quoted keys': '"a b": 1\n\'c\': 2',
  'a list item that is a list of keys': '-   a: 1\n    b: 2',
};

describe('accepted documents read as Bun.YAML reads them', () => {
  for (const [name, text] of Object.entries(accepted)) {
    test(name, () => {
      expect(toValue(parseYaml(text))).toEqual(Bun.YAML.parse(text) as never);
    });
  }
});

// The documents live in test/fixtures/yaml so a conformance run can refuse the same bytes.
// The line and the message stay here: the runner only checks accepted or refused.
const refused: [string, string, number, RegExp][] = [
  ['an empty file', 'an-empty-file', 1, /empty/],
  ['a duplicate key', 'a-duplicate-key', 3, /duplicate key "a"/],
  ['a duplicate key in a nested map', 'a-duplicate-key-in-a-nested-map', 3, /duplicate key/],
  ['a duplicate key in a flow map', 'a-duplicate-key-in-a-flow-map', 1, /duplicate key/],
  ['a duplicate quoted key', 'a-duplicate-quoted-key', 2, /duplicate key/],
  ['a tab in the indentation', 'a-tab-in-the-indentation', 2, /tab/],
  ['an anchor', 'an-anchor', 1, /anchors/],
  ['an alias', 'an-alias', 1, /aliases/],
  ['a tag', 'a-tag', 1, /tags/],
  ['a literal block', 'a-literal-block', 1, /block scalars/],
  ['a folded block', 'a-folded-block', 1, /block scalars/],
  ['a document marker', 'a-document-marker', 1, /document markers/],
  ['a second document', 'a-second-document', 2, /document markers/],
  ['a directive', 'a-directive', 1, /directives/],
  ['a merge key', 'a-merge-key', 2, /merge keys/],
  ['a complex key', 'a-complex-key', 1, /complex keys/],
  ['an unclosed double quote', 'an-unclosed-double-quote', 1, /not closed/],
  ['an unclosed single quote', 'an-unclosed-single-quote', 1, /not closed/],
  ['text after a quoted string', 'text-after-a-quoted-string', 1, /after a quoted string/],
  ['an unknown escape', 'an-unknown-escape', 1, /unknown escape/],
  ['a flow list left open', 'a-flow-list-left-open', 1, /expected "," or "\]"/],
  ['a flow map across lines', 'a-flow-map-across-lines', 1, /not closed/],
  ['text after a flow list', 'text-after-a-flow-list', 1, /unexpected text/],
  ['a line that is no key', 'a-line-that-is-no-key', 2, /expected "key: value"/],
  ['a deeper line with no parent', 'a-deeper-line-with-no-parent', 2, /unexpected indentation/],
  ['a list item among keys', 'a-list-item-among-keys', 2, /list item where a key/],
  ['a list inside a list item', 'a-list-inside-a-list-item', 1, /list directly inside/],
  ['an indented first line', 'an-indented-first-line', 1, /first line/],
  ['a value that starts with @', 'a-value-that-starts-with', 1, /quote it/],
  ['a second key on a key\'s line', 'a-second-key-on-a-key-s-line', 1, /must be quoted/],
  ['a value that ends with a colon', 'a-value-that-ends-with-a-colon', 1, /must be quoted/],
  ['a list on its key\'s line', 'a-list-on-its-key-s-line', 1, /can't start on its key's line/],
];

describe('what the subset refuses, a full parser refuses or reads otherwise', () => {
  test('"a: b: c" and "a: - x" are errors for Bun.YAML too', () => {
    expect(() => Bun.YAML.parse('a: b: c')).toThrow();
    expect(() => Bun.YAML.parse('a: - x')).toThrow();
  });
});

describe('everything outside the subset is refused with its line', () => {
  for (const [name, slug, line, message] of refused) {
    test(name, () => {
      const text = readFileSync(new URL(`./fixtures/yaml/${slug}.yaml`, import.meta.url), 'utf8');
      let error: unknown;
      try {
        parseYaml(text);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(YamlError);
      expect((error as YamlError).line).toBe(line);
      expect((error as YamlError).message).toMatch(message);
    });
  }
});

describe('nodes keep what validation needs', () => {
  test('lines, and whether a scalar was quoted', () => {
    const root = parseYaml('a: 4.10\nb: "4.10"\nc:\n  - x');
    if (root.kind !== 'map') throw new Error('not a map');
    const [a, b, c] = root.entries;
    expect(a?.value).toMatchObject({ kind: 'scalar', value: 4.1, raw: '4.10', quoted: false, line: 1 });
    expect(b?.value).toMatchObject({ kind: 'scalar', value: '4.10', quoted: true, line: 2 });
    expect(c?.line).toBe(3);
    expect(c?.value).toMatchObject({ kind: 'seq', line: 4 });
  });
});
