// The regex dialect both engines share. The loader rewrites the shorthand classes
// before compiling, so a pattern means the same thing under JavaScript's `u` flag
// and under Rust's Unicode mode. The shape rules are what bound a single pattern:
// JavaScript cannot interrupt a RegExp that is already running.

const MAX_PATTERN = 200;
const MAX_QUANTIFIER = 1000;

// JavaScript's `\s`, ASCII and the Unicode spaces it has matched since ES2019.
// U+180E is not among them. The set is fixed so the rewrite does not depend on
// which flag the host gives `\s`.
const WS_CODEPOINTS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

const DIGITS = range(0x30, 0x39);
const WORD = [...range(0x30, 0x39), ...range(0x41, 0x5a), ...range(0x61, 0x7a), 0x5f];

export class DialectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialectError';
  }
}

/** Compile one pattern. `ignoreCase` is the stage's flag, never an inline `(?i)`. */
export function compilePattern(source: string, ignoreCase = false): RegExp {
  if (source.length === 0) throw new DialectError('a pattern is empty');
  if (source.length > MAX_PATTERN) throw new DialectError(`a pattern is longer than ${MAX_PATTERN} characters`);
  refuseSpelling(source);
  const parser = new Parser(source);
  const body = parser.parseAlt();
  if (!parser.done()) throw new DialectError('a pattern has an extra ")"');
  const flags = ignoreCase ? 'iu' : 'u';
  return new RegExp(body.source, flags);
}

type Node = {
  source: string;
  min: number;
  max: number;
  /** A single unquantified character, the only thing that may open a repeated alternation. */
  literal: boolean;
  group: boolean;
  branches: Node[][];
};

class Parser {
  private at = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  done(): boolean {
    return this.at >= this.source.length;
  }

  parseAlt(): Node {
    const branches = [this.parseSeq()];
    while (this.eat('|')) branches.push(this.parseSeq());
    return {
      source: branches.map((branch) => seqSource(branch)).join('|'),
      min: 1,
      max: 1,
      literal: false,
      group: branches.length > 1,
      branches,
    };
  }

  private parseSeq(): Node[] {
    const atoms: Node[] = [];
    while (!this.done() && this.peek() !== '|' && this.peek() !== ')') atoms.push(this.parseAtom());
    return atoms;
  }

  private parseAtom(): Node {
    const piece = this.parsePiece();
    const quant = this.parseQuantifier();
    if (!quant) return piece;
    if (piece.group && quant.unbounded) this.checkRepeatedGroup(piece);
    return {
      source: piece.source + quant.source,
      min: quant.min,
      max: quant.max,
      literal: false,
      group: piece.group,
      branches: piece.branches,
    };
  }

  // A group under `*`, `+` or `{n,}` whose first atom is optional or itself repeated
  // backtracks badly. Alternation is allowed only when every branch opens on a literal.
  private checkRepeatedGroup(group: Node): void {
    if (group.branches.length > 1) {
      for (const branch of group.branches) {
        const first = branch[0];
        if (!first?.literal) throw new DialectError('a repeated alternation must open every branch with a literal');
      }
      return;
    }
    if (risky(group.branches[0]?.[0])) throw new DialectError('a repeated group starts with an optional or repeated atom');
  }

  private parsePiece(): Node {
    const ch = this.peek();
    if (ch === undefined || ch === '|' || ch === ')' || ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      throw new DialectError('a quantifier needs something to repeat');
    }
    if (ch === '(') return this.parseGroup();
    if (ch === '[') return this.leaf(this.parseClass(), false);
    if (ch === '^' || ch === '$') {
      this.at++;
      return this.leaf(ch, false);
    }
    if (ch === '.') {
      this.at++;
      return this.leaf('.', false);
    }
    if (ch === '\\') return this.parseEscape();
    if (ch === ')') throw new DialectError('a pattern has an extra ")"');
    const cp = this.readCodePoint();
    return this.leaf(escapeLiteral(cp), true);
  }

  private parseGroup(): Node {
    this.expect('(');
    if (this.peek() !== '?') {
      const body = this.parseAlt();
      this.expect(')');
      return { ...body, source: `(${body.source})`, group: true, literal: false };
    }
    this.expect('?');
    if (this.peek() === ':') {
      this.expect(':');
      const body = this.parseAlt();
      this.expect(')');
      return { ...body, source: `(?:${body.source})`, group: true, literal: false };
    }
    throw new DialectError('lookaround, named groups and inline flags are not allowed');
  }

  private parseQuantifier(): { source: string; min: number; max: number; unbounded: boolean } | null {
    const ch = this.peek();
    if (ch !== '*' && ch !== '+' && ch !== '?' && ch !== '{') return null;
    this.at++;
    let min: number;
    let max: number;
    let text: string;
    let unbounded: boolean;
    if (ch === '*') { min = 0; max = Infinity; text = '*'; unbounded = true; }
    else if (ch === '+') { min = 1; max = Infinity; text = '+'; unbounded = true; }
    else if (ch === '?') { min = 0; max = 1; text = '?'; unbounded = false; }
    else {
      const count = this.readCount();
      min = count.min;
      max = count.max;
      text = count.text;
      unbounded = count.max === Infinity;
    }
    if (this.peek() === '?') { this.at++; text += '?'; }
    return { source: text, min, max, unbounded };
  }

  private readCount(): { min: number; max: number; text: string } {
    const start = this.at;
    const first = this.readNumber();
    if (first === null) throw new DialectError('a "{ }" quantifier needs a number');
    if (this.eat(',')) {
      const second = this.readNumber();
      this.expect('}');
      if (second === null) return { min: first, max: Infinity, text: this.source.slice(start - 1, this.at) };
      if (second < first) throw new DialectError('a "{n,m}" quantifier has m below n');
      return { min: first, max: second, text: this.source.slice(start - 1, this.at) };
    }
    this.expect('}');
    return { min: first, max: first, text: this.source.slice(start - 1, this.at) };
  }

  private readNumber(): number | null {
    const start = this.at;
    while (this.peek() !== undefined && this.peek()! >= '0' && this.peek()! <= '9') this.at++;
    if (this.at === start) return null;
    const n = Number(this.source.slice(start, this.at));
    if (n > MAX_QUANTIFIER) throw new DialectError(`a quantifier is above ${MAX_QUANTIFIER}`);
    return n;
  }

  private parseClass(): string {
    this.expect('[');
    const negated = this.eat('^');
    const parts: ClassPart[] = [];
    let first = true;
    while (!this.done() && (this.peek() !== ']' || first)) {
      first = false;
      if (this.peek() === '\\') parts.push(this.parseClassEscape());
      else parts.push({ kind: 'char', cp: this.readCodePoint() });
    }
    this.expect(']');
    return classSource(negated, foldRanges(parts));
  }

  private parseClassEscape(): ClassPart {
    this.expect('\\');
    const ch = this.peek();
    if (ch === undefined) throw new DialectError('a pattern ends with "\\"');
    this.at++;
    const shorthand = shorthandSet(ch);
    if (shorthand) return shorthand;
    const cp = simpleEscape(ch);
    if (cp === null) throw new DialectError(`an unsupported escape "\\${ch}"`);
    return { kind: 'char', cp };
  }

  private parseEscape(): Node {
    this.expect('\\');
    const ch = this.peek();
    if (ch === undefined) throw new DialectError('a pattern ends with "\\"');
    this.at++;
    if (ch >= '1' && ch <= '9') throw new DialectError('backreferences are not allowed');
    if (ch === 'b') return this.leaf('\\b', false);
    const shorthand = shorthandSet(ch);
    if (shorthand?.kind === 'chars') return this.leaf(emitClass(false, shorthand.cps), false);
    if (shorthand?.kind === 'not') return this.leaf(emitClass(true, shorthand.cps), false);
    const cp = simpleEscape(ch);
    if (cp === null) throw new DialectError(`an unsupported escape "\\${ch}"`);
    return this.leaf(escapeLiteral(cp), true);
  }

  private leaf(source: string, literal: boolean): Node {
    return { source, min: 1, max: 1, literal, group: false, branches: [] };
  }

  private peek(): string | undefined {
    return this.source[this.at];
  }

  private eat(ch: string): boolean {
    if (this.peek() !== ch) return false;
    this.at++;
    return true;
  }

  private expect(ch: string): void {
    if (!this.eat(ch)) throw new DialectError(`expected "${ch}"`);
  }

  private readCodePoint(): number {
    const cp = this.source.codePointAt(this.at);
    if (cp === undefined) throw new DialectError('a pattern ended early');
    this.at += cp > 0xffff ? 2 : 1;
    return cp;
  }
}

type ClassPart =
  | { kind: 'char'; cp: number }
  | { kind: 'chars'; cps: number[] }
  | { kind: 'not'; cps: number[] };

function shorthandSet(ch: string): ClassPart | null {
  if (ch === 'd') return { kind: 'chars', cps: DIGITS };
  if (ch === 'w') return { kind: 'chars', cps: WORD };
  if (ch === 's') return { kind: 'chars', cps: WS_CODEPOINTS };
  if (ch === 'D') return { kind: 'not', cps: DIGITS };
  if (ch === 'W') return { kind: 'not', cps: WORD };
  if (ch === 'S') return { kind: 'not', cps: WS_CODEPOINTS };
  return null;
}

function simpleEscape(ch: string): number | null {
  if (ch === 'n') return 0x0a;
  if (ch === 'r') return 0x0d;
  if (ch === 't') return 0x09;
  if (ch === 'f') return 0x0c;
  if (ch === 'v') return 0x0b;
  if (ch === 'b') return null;
  if ('\\.^$|?*+()[]{}-/'.includes(ch)) return ch.codePointAt(0) as number;
  return null;
}

function refuseSpelling(source: string): void {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '\\') continue;
    const next = source[i + 1];
    if (next === 'u' || next === 'U' || next === 'x') throw new DialectError('a "\\u" or "\\x" escape is not allowed: write the character itself');
    if (next === '\\') i++;
  }
}

// A class is a finite set, except a complement shorthand (`\S`, `\D`, `\W`), whose
// negation brings it back to a finite set. `[^\S\n]` is the whitespace set without
// a newline, which is what the working-line pattern relies on. A positive class that
// mixed one with other members would compile to a class nobody wrote (`[\D0-9]` is
// everything), so it is refused rather than rewritten.
function classSource(negated: boolean, parts: ClassPart[]): string {
  const positive = new Set<number>();
  const complements: number[][] = [];
  for (const part of parts) {
    if (part.kind === 'char') positive.add(part.cp);
    else if (part.kind === 'chars') for (const cp of part.cps) positive.add(cp);
    else complements.push(part.cps);
  }
  if (complements.length === 0) return emitClass(negated, [...positive]);
  if (!negated && positive.size > 0) {
    throw new DialectError('a class cannot mix a complement shorthand with other members: negate the class, or write the shorthand alone');
  }
  let inter = new Set(complements[0]);
  for (const extra of complements.slice(1)) inter = new Set([...inter].filter((cp) => extra.includes(cp)));
  const remaining = [...inter].filter((cp) => !positive.has(cp));
  return emitClass(!negated, remaining);
}

function foldRanges(parts: ClassPart[]): ClassPart[] {
  const out: ClassPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as ClassPart;
    const next = parts[i + 1];
    const after = parts[i + 2];
    if (part.kind === 'char' && next?.kind === 'char' && next.cp === 0x2d && after?.kind === 'char') {
      // A hyphen between two characters is a range. A hyphen after a shorthand stays a hyphen.
      if (after.cp < part.cp) throw new DialectError('a character range is backwards');
      const cps: number[] = [];
      for (let cp = part.cp; cp <= after.cp; cp++) cps.push(cp);
      out.push({ kind: 'chars', cps });
      i += 2;
    } else out.push(part);
  }
  return out;
}

function emitClass(negated: boolean, cps: number[]): string {
  const sorted = [...new Set(cps)].sort((a, b) => a - b);
  let body = '';
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i] as number;
    let end = start;
    while (i + 1 < sorted.length && (sorted[i + 1] as number) === end + 1) { i++; end = sorted[i] as number; }
    if (end - start >= 2) body += classChar(start) + '-' + classChar(end);
    else for (let cp = start; cp <= end; cp++) body += classChar(cp);
    i++;
  }
  if (!body) return negated ? '[\\s\\S]' : '[^\\s\\S]';
  return negated ? `[^${body}]` : `[${body}]`;
}

function classChar(cp: number): string {
  if (cp === 0x09) return '\\t';
  if (cp === 0x0a) return '\\n';
  if (cp === 0x0b) return '\\v';
  if (cp === 0x0c) return '\\f';
  if (cp === 0x0d) return '\\r';
  if (cp === 0x2d || cp === 0x5d || cp === 0x5e || cp === 0x5c) return `\\${String.fromCodePoint(cp)}`;
  if (cp < 0x20 || cp > 0x7e) return codePointEscape(cp);
  return String.fromCodePoint(cp);
}

function escapeLiteral(cp: number): string {
  const ch = String.fromCodePoint(cp);
  if ('\\.^$|?*+()[]{}'.includes(ch)) return `\\${ch}`;
  if (cp < 0x20 || cp > 0x7e) return codePointEscape(cp);
  return ch;
}

// A code point above U+FFFF needs the "\u{…}" form, which every pattern can carry: the "u"
// flag is always set (compilePattern). A four-digit escape cannot spell it — the digits
// would spill into the following character.
function codePointEscape(cp: number): string {
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
}

function seqSource(atoms: Node[]): string {
  return atoms.map((atom) => atom.source).join('');
}

// Optional (`?`, `*`, `{0,…}`) or repeated (`+`, `*`, `{n,}` with room for more than one).
// A group that is itself exactly once still counts when its own first atom is.
function risky(atom: Node | undefined): boolean {
  if (!atom) return true;
  if (atom.min === 0 || atom.max > 1) return true;
  if (!atom.group) return false;
  if (atom.branches.length > 1) return atom.branches.some((branch) => !branch[0]?.literal);
  return risky(atom.branches[0]?.[0]);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let cp = from; cp <= to; cp++) out.push(cp);
  return out;
}
