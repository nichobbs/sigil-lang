// S-expression reader. The canonical agent-facing surface of Sigil is a thin
// serialization of the typed graph; this reader is its only lexical layer.

export interface Pos {
  line: number;
  col: number;
}

export type SExp =
  | { t: 'int'; v: bigint; pos: Pos }
  | { t: 'str'; v: string; pos: Pos }
  | { t: 'sym'; v: string; pos: Pos }
  | { t: 'list'; items: SExp[]; bracket: boolean; pos: Pos };

export class SigilError extends Error {
  constructor(
    msg: string,
    public pos?: Pos,
  ) {
    super(pos ? `${pos.line}:${pos.col}: ${msg}` : msg);
    this.name = 'SigilError';
  }
}

const DELIM = /[\s()\[\]";]/;

export function readAll(src: string): SExp[] {
  let i = 0;
  let line = 1;
  let col = 1;
  const pos = (): Pos => ({ line, col });
  const adv = (): string => {
    const c = src[i++];
    if (c === '\n') {
      line++;
      col = 1;
    } else col++;
    return c;
  };

  function skip(): void {
    for (;;) {
      const c = src[i];
      if (c === undefined) return;
      if (/\s/.test(c)) adv();
      else if (c === ';') {
        while (i < src.length && src[i] !== '\n') adv();
      } else return;
    }
  }

  function read(): SExp {
    skip();
    const p = pos();
    const c = src[i];
    if (c === '(' || c === '[') {
      adv();
      const close = c === '(' ? ')' : ']';
      const items: SExp[] = [];
      for (;;) {
        skip();
        if (i >= src.length) throw new SigilError(`unclosed '${c}'`, p);
        const d = src[i];
        if (d === close) {
          adv();
          break;
        }
        if (d === ')' || d === ']') throw new SigilError(`mismatched '${d}', expected '${close}'`, pos());
        items.push(read());
      }
      return { t: 'list', items, bracket: c === '[', pos: p };
    }
    if (c === ')' || c === ']') throw new SigilError(`unexpected '${c}'`, p);
    if (c === '"') {
      adv();
      let s = '';
      for (;;) {
        if (i >= src.length) throw new SigilError('unterminated string', p);
        const d = adv();
        if (d === '"') break;
        if (d === '\\') {
          const e = adv();
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else s += d;
      }
      return { t: 'str', v: s, pos: p };
    }
    let tok = '';
    while (i < src.length && !DELIM.test(src[i])) tok += adv();
    if (/^-?\d[\d_]*$/.test(tok)) return { t: 'int', v: BigInt(tok.replace(/_/g, '')), pos: p };
    return { t: 'sym', v: tok, pos: p };
  }

  const out: SExp[] = [];
  for (;;) {
    skip();
    if (i >= src.length) break;
    out.push(read());
  }
  return out;
}

export function sexpToString(s: SExp): string {
  switch (s.t) {
    case 'int':
      return s.v.toString();
    case 'str':
      return JSON.stringify(s.v);
    case 'sym':
      return s.v;
    case 'list': {
      const [o, c] = s.bracket ? ['[', ']'] : ['(', ')'];
      return o + s.items.map(sexpToString).join(' ') + c;
    }
  }
}

export const isSym = (s: SExp | undefined, v?: string): s is Extract<SExp, { t: 'sym' }> =>
  !!s && s.t === 'sym' && (v === undefined || s.v === v);
export const isList = (s: SExp | undefined): s is Extract<SExp, { t: 'list' }> => !!s && s.t === 'list';
export const isKeyword = (s: SExp | undefined): s is Extract<SExp, { t: 'sym' }> =>
  !!s && s.t === 'sym' && s.v.startsWith(':') && s.v.length > 1;
