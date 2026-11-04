// Minimal hand-written WebAssembly binary encoder: just enough for pure numeric functions
// (type, function, export and code sections; i32/i64 only; no memory, no imports).

export type ValType = 'i32' | 'i64';
const VT: Record<ValType, number> = { i32: 0x7f, i64: 0x7e };

export function uleb(n: number | bigint): number[] {
  let v = BigInt(n);
  if (v < 0n) throw new Error('uleb: negative');
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return out;
}

export function sleb(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n; // arithmetic shift for bigint
    const signBit = (b & 0x40) !== 0;
    if ((v === 0n && !signBit) || (v === -1n && signBit)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const utf8 = (s: string): number[] => {
  const b = [...new TextEncoder().encode(s)];
  return [...uleb(b.length), ...b];
};
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

/** Opcodes for one integer width. */
export interface IntOps {
  vt: ValType;
  const(v: bigint): number[];
  eqz: number;
  eq: number;
  ne: number;
  ltS: number;
  gtS: number;
  leS: number;
  geS: number;
  add: number;
  sub: number;
  mul: number;
  divS: number;
  remS: number;
  xor: number;
  and: number;
  or: number;
}

export const I32: IntOps = {
  vt: 'i32',
  const: (v) => [0x41, ...sleb(v)],
  eqz: 0x45, eq: 0x46, ne: 0x47, ltS: 0x48, gtS: 0x4a, leS: 0x4c, geS: 0x4e,
  add: 0x6a, sub: 0x6b, mul: 0x6c, divS: 0x6d, remS: 0x6f, and: 0x71, or: 0x72, xor: 0x73,
};
export const I64: IntOps = {
  vt: 'i64',
  const: (v) => [0x42, ...sleb(v)],
  eqz: 0x50, eq: 0x51, ne: 0x52, ltS: 0x53, gtS: 0x55, leS: 0x57, geS: 0x59,
  add: 0x7c, sub: 0x7d, mul: 0x7e, divS: 0x7f, remS: 0x81, and: 0x83, or: 0x84, xor: 0x85,
};

export const OP = {
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  select: 0x1b,
  localGet: 0x20,
  localSet: 0x21,
  i64ExtendI32U: 0xad,
};

export const localGet = (i: number) => [OP.localGet, ...uleb(i)];
export const localSet = (i: number) => [OP.localSet, ...uleb(i)];
export const blockType = (vt: ValType) => VT[vt];

export interface WasmFunc {
  name: string;
  params: ValType[];
  result: ValType;
  locals: ValType[]; // beyond params
  body: number[]; // instructions, without the final `end`
}

export function buildModule(funcs: WasmFunc[]): Uint8Array {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (!funcs.length) return Uint8Array.from(header);

  const typeKeys: string[] = [];
  const types: number[][] = [];
  const typeIdx = funcs.map((f) => {
    const key = `${f.params.join(',')}->${f.result}`;
    let i = typeKeys.indexOf(key);
    if (i < 0) {
      i = typeKeys.length;
      typeKeys.push(key);
      types.push([0x60, ...vec(f.params.map((p) => [VT[p]])), ...vec([[VT[f.result]]])]);
    }
    return i;
  });

  const code = funcs.map((f) => {
    const body = [...vec(f.locals.map((l) => [1, VT[l]])), ...f.body, OP.end];
    return [...uleb(body.length), ...body];
  });

  return Uint8Array.from([
    ...header,
    ...section(1, vec(types)),
    ...section(3, vec(typeIdx.map((t) => uleb(t)))),
    ...section(7, vec(funcs.map((f, i) => [...utf8(f.name), 0x00, ...uleb(i)]))),
    ...section(10, vec(code)),
  ]);
}
